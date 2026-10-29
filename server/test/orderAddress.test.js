import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { istDate } from '../src/routes/delivery.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  // Mumbai next day; Andaman not delivered to.
  for (const zone of [
    { prefix: '400', name: 'Mumbai', deliverable: true, minDays: 1, maxDays: 1 },
    { prefix: '744', name: 'Andaman', deliverable: false, minDays: 1, maxDays: 1 },
  ]) {
    assert.equal((await admin('POST', '/admin/delivery/zones', zone)).status, 201);
  }
});
after(() => t.stop());

let n = 0;
async function register(email = `mover${++n}@example.com`, name = 'Asha Rao') {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  call.email = email;
  return call;
}

const home = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  line2: '',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
const office = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '4 Nariman Point',
  line2: 'Floor 3',
  city: 'Mumbai',
  state: 'maharashtra',
  pincode: '400021',
};
async function order(call) {
  const p = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const quote = await call('GET', `/cart?items=${p._id}:1`);
  const res = await call('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty: 1 }],
    address: home,
    expectedTotal: quote.body.total,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
const mailTo = (email, subject) => t.mail.sent.findLast((m) => m.to.email === email && m.subject.startsWith(subject));

test('the customer changes the address before it ships: checked, new dates, history for admins, both told', async () => {
  const call = await register();
  const placed = await order(call);
  const change = (body) => call('POST', `/orders/${placed.id}/address`, body);

  assert.equal((await change({ ...office, pincode: '12345' })).status, 400);
  assert.equal((await change({ ...office, state: 'Atlantis' })).status, 400);
  const same = await change(home);
  assert.equal(same.status, 400);
  assert.equal(same.body.error, 'That is already the delivery address');
  const far = await change({ ...office, pincode: '744101' });
  assert.equal(far.status, 409);
  assert.equal(far.body.error, "Sorry, we don't deliver to 744101 yet.");
  assert.equal((await (await register())('POST', `/orders/${placed.id}/address`, office)).status, 404);
  assert.equal((await t.call('POST', `/orders/${placed.id}/address`, office)).status, 401);

  const res = await change(office);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.address.state, 'Maharashtra');
  assert.equal(res.body.address.line1, '4 Nariman Point');
  // Mumbai is next day, counted from the day it was ordered.
  const ordered = new Date(placed.createdAt);
  assert.deepEqual(res.body.deliveryEstimate, { from: istDate(ordered, 1), to: istDate(ordered, 1) });
  assert.ok(res.body.addressChangedAt);
  assert.equal(res.body.addressChanges, undefined); // customers don't get the history

  const mine = mailTo(call.email, `New delivery address for order #${placed.number}`);
  assert.match(mine.text, /4 Nariman Point, Floor 3, Mumbai, Maharashtra 400021/);
  assert.match(mine.text, /If you didn't make this change/);
  const alert = mailTo('owner@example.com', `Order #${placed.number}: new delivery address`);
  assert.match(alert.text, /Before: Asha Rao, 12 MG Road, Bengaluru, Karnataka 560001/);

  const adminView = (await admin('GET', `/admin/orders/${placed.id}`)).body;
  assert.equal(adminView.addressChanges.length, 1);
  assert.equal(adminView.addressChanges[0].from.line1, '12 MG Road');
  assert.equal(adminView.addressChanges[0].role, 'customer');
  assert.equal(adminView.addressChanges[0].by, 'Asha Rao');
  // Customers' changes aren't in the admins' activity log.
  assert.equal(await t.db.collection('activity').countDocuments({ action: 'Changed delivery address' }), 0);

  // Once shipped, no more changes.
  await admin('POST', `/admin/orders/${placed.id}/status`, { status: 'shipped' });
  const shipped = await change(home);
  assert.equal(shipped.status, 409);
  assert.match(shipped.body.error, /before the order ships; this one is shipped/);
});

test('an admin changes it for the customer (logged, customer told, no alert to admins); at most 5 changes', async () => {
  const call = await register();
  const placed = await order(call);
  const before = t.mail.sent.length;
  assert.equal((await call('POST', `/admin/orders/${placed.id}/address`, office)).status, 403);
  const res = await admin('POST', `/admin/orders/${placed.id}/address`, { ...office, phone: '9123456780' });
  assert.equal(res.status, 200);
  assert.equal(res.body.addressChanges[0].role, 'admin');
  const sent = t.mail.sent.slice(before);
  assert.deepEqual(
    sent.map((m) => m.to.email),
    [call.email],
  );
  assert.match(sent[0].text, /as you asked/);
  const entry = await t.db.collection('activity').findOne({ action: 'Changed delivery address' });
  assert.equal(entry.area, 'orders');
  assert.match(entry.changes[0].from, /12 MG Road/);
  assert.match(entry.changes[0].to, /9123456780/);

  // Four more changes, then refused.
  for (let i = 0; i < 4; i++) {
    const r = await call('POST', `/orders/${placed.id}/address`, { ...home, line2: `Flat ${i + 1}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const sixth = await call('POST', `/orders/${placed.id}/address`, home);
  assert.equal(sixth.status, 409);
  assert.match(sixth.body.error, /changed 5 times/);
});

test('closing the account drops the earlier addresses with the rest of the personal details', async () => {
  const call = await register();
  const placed = await order(call);
  await call('POST', `/orders/${placed.id}/address`, office);
  await admin('POST', `/admin/orders/${placed.id}/status`, { status: 'shipped' });
  await admin('POST', `/admin/orders/${placed.id}/status`, { status: 'delivered' });
  assert.equal((await call('POST', '/account/close', { password: 'password123', confirm: true })).status, 204);
  const doc = await t.db.collection('orders').findOne({ number: placed.number });
  assert.equal(doc.address.line1, '');
  assert.equal(doc.addressChanges, undefined);
});
