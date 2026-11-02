import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { CALL_AFTER_MS } from '../src/codConfirm.js';

let t;
let admin;
let support;
before(async () => {
  t = await startTestServer({ razorpay: true });
  admin = await register('owner@example.com', 'Store Owner');
  support = await register('support@example.com', 'Sunil Support');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  await t.db.collection('users').updateOne({ email: 'support@example.com' }, { $set: { role: 'support' } });
});
after(() => t.stop());
beforeEach(async () => {
  await t.db.collection('settings').updateOne({ _id: 'cod' }, { $set: { confirm: true } }, { upsert: true });
  t.mail.sent.length = 0;
});

let n = 0;
async function register(email = `buyer${++n}@example.com`, name = 'Asha Rao') {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  call.email = email;
  return call;
}

const BOOK = 'the-quiet-engineer-paperback';
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
async function place(call, { online = false, extra = {} } = {}) {
  const p = await t.db.collection('products').findOne({ slug: BOOK });
  const quote = await call('GET', `/cart?items=${p._id}:1`);
  const res = await call('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty: 1 }],
    address,
    expectedTotal: quote.body.total,
    paymentMethod: online ? 'razorpay' : 'cod',
    ...extra,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
// The token from the confirmation email's "Yes, ship it" link.
function tokenFrom(email) {
  const match = email.text.match(/\/confirm-order#token=([\w-]+)/);
  assert.ok(match, 'the email has a confirm link');
  return match[1];
}
const placedEmail = (to) => t.mail.sent.find((m) => m.to.email === to && /confirmed/i.test(m.subject));
test('a COD order asks to be confirmed, and the email link confirms it without logging in', async () => {
  const buyer = await register();
  const order = await place(buyer);
  assert.deepEqual(order.codConfirm, { confirmedAt: null, by: null, callNow: false });
  const email = placedEmail(buyer.email);
  assert.match(email.text, /Please confirm you'll pay ₹389 in cash on delivery/);
  assert.match(email.html, /Yes, ship it/);
  const token = tokenFrom(email);
  // Only the token's hash is kept.
  const doc = await t.db.collection('orders').findOne({ number: order.number });
  assert.ok(doc.codConfirm.tokenHash);
  assert.ok(!JSON.stringify(doc).includes(token));

  const guest = t.browser();
  const res = await guest('POST', '/cod-confirmations', { token });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['confirmedAt', 'number', 'status']);
  assert.equal(res.body.number, order.number);
  assert.ok(res.body.confirmedAt);
  // A second click is fine and keeps the first time.
  const again = await guest('POST', '/cod-confirmations', { token });
  assert.equal(again.status, 200);
  assert.equal(again.body.confirmedAt, res.body.confirmedAt);

  const mine = (await buyer('GET', `/orders/${order.id}`)).body;
  assert.equal(mine.codConfirm.by, 'customer');
  assert.equal(mine.codConfirm.callNow, false);
  assert.equal(mine.codConfirm.byName, undefined);
});

test('wrong or malformed tokens are refused', async () => {
  const guest = t.browser();
  assert.equal((await guest('POST', '/cod-confirmations', { token: 'x'.repeat(24) })).status, 404);
  assert.equal((await guest('POST', '/cod-confirmations', { token: 'short' })).status, 400);
  assert.equal((await guest('POST', '/cod-confirmations', {})).status, 400);
});

test('the customer can confirm from the order page; others get a 404', async () => {
  const buyer = await register();
  const other = await register();
  const order = await place(buyer);
  assert.equal((await other('POST', `/orders/${order.id}/confirm-cod`)).status, 404);
  assert.equal((await t.browser()('POST', `/orders/${order.id}/confirm-cod`)).status, 401);
  const res = await buyer('POST', `/orders/${order.id}/confirm-cod`);
  assert.equal(res.status, 200);
  assert.ok(res.body.confirmedAt);
});

test('nothing to confirm while switched off, or for online orders', async () => {
  await t.db.collection('settings').updateOne({ _id: 'cod' }, { $set: { confirm: false } });
  const buyer = await register();
  const off = await place(buyer);
  assert.equal(off.codConfirm, null);
  assert.doesNotMatch(placedEmail(buyer.email).text, /confirm-order/);
  assert.equal((await buyer('POST', `/orders/${off.id}/confirm-cod`)).status, 409);

  await t.db.collection('settings').updateOne({ _id: 'cod' }, { $set: { confirm: true } });
  const online = await place(buyer, { online: true });
  assert.equal(online.codConfirm, null);
});

test('a cancelled order cannot be confirmed; a shipped one counts as confirmed', async () => {
  const buyer = await register();
  const cancelled = await place(buyer);
  assert.equal((await buyer('POST', `/orders/${cancelled.id}/cancel`, {})).status, 200);
  const res = await buyer('POST', `/orders/${cancelled.id}/confirm-cod`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /cancelled/);

  const shipped = await place(buyer);
  assert.equal((await admin('POST', `/admin/orders/${shipped.id}/status`, { status: 'shipped' })).status, 200);
  const late = await buyer('POST', `/orders/${shipped.id}/confirm-cod`);
  assert.equal(late.status, 200);
  assert.equal(late.body.status, 'shipped');
  assert.equal(late.body.confirmedAt, null);
});

test('unconfirmed orders a day old are listed to call, and staff can mark them confirmed by phone', async () => {
  const buyer = await register();
  const fresh = await place(buyer);
  const old = await place(buyer);
  await t.db
    .collection('orders')
    .updateOne({ number: old.number }, { $set: { createdAt: new Date(Date.now() - CALL_AFTER_MS - 60_000) } });

  const list = (await admin('GET', '/admin/orders?confirm=waiting')).body;
  const numbers = list.items.map((o) => o.number);
  assert.ok(numbers.includes(old.number));
  assert.ok(!numbers.includes(fresh.number));
  assert.equal(list.unconfirmed, list.total);
  assert.equal(list.items.find((o) => o.number === old.number).codConfirm.callNow, true);
  assert.equal((await admin('GET', '/admin/dashboard')).body.codToCall, list.total);

  // Customers can't use the admin route; support staff can.
  assert.equal((await buyer('POST', `/admin/orders/${old.id}/confirm-cod`)).status, 403);
  const res = await support('POST', `/admin/orders/${old.id}/confirm-cod`);
  assert.equal(res.status, 200);
  const seen = (await admin('GET', `/admin/orders/${old.id}`)).body.codConfirm;
  assert.equal(seen.by, 'staff');
  assert.equal(seen.byName, 'Sunil Support');
  assert.equal(seen.callNow, false);
  // The customer sees that it's confirmed, not who did it.
  assert.equal((await buyer('GET', `/orders/${old.id}`)).body.codConfirm.byName, undefined);

  const after = (await admin('GET', '/admin/orders?confirm=waiting')).body;
  assert.ok(!after.items.some((o) => o.number === old.number));
  const log = await t.db.collection('activity').find({ action: 'Confirmed by phone' }).toArray();
  assert.equal(log.length, 1);
  // Confirming again changes and logs nothing.
  assert.equal((await support('POST', `/admin/orders/${old.id}/confirm-cod`)).status, 200);
  assert.equal(await t.db.collection('activity').countDocuments({ action: 'Confirmed by phone' }), 1);
});

test('the switch is saved with the COD rules and logged; forms without it keep it', async () => {
  await t.db.collection('settings').deleteOne({ _id: 'cod' });
  assert.equal((await admin('GET', '/admin/cod')).body.confirm, false);
  const on = await admin('PUT', '/admin/cod', { maxOrder: null, refusedLimit: 2, confirm: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.confirm, true);
  const kept = await admin('PUT', '/admin/cod', { maxOrder: null, refusedLimit: 3 });
  assert.equal(kept.body.confirm, true);
  const entry = await t.db.collection('activity').findOne({ 'changes.field': 'Ask customers to confirm' });
  assert.deepEqual(
    entry.changes.find((c) => c.field === 'Ask customers to confirm'),
    { field: 'Ask customers to confirm', from: 'Off', to: 'On' },
  );
});
