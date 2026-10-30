import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { arrival } from '../src/emails.js';
import { istDate } from '../src/routes/delivery.js';
import { statesForPin } from '../src/pinStates.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  customer = await register('customer@example.com', 'Asha Rao');
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}

const address = (pincode) => ({
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  // A state the PIN code is in (addresses are checked against it).
  state: statesForPin(pincode)[0],
  pincode,
});
async function order(pincode) {
  const p = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const quote = await customer('GET', `/cart?items=${p._id}:1`);
  const res = await customer('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty: 1 }],
    address: address(pincode),
    expectedTotal: quote.body.total,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('"by" one day, or "between" two, in India time', () => {
  assert.equal(arrival({ from: '2026-10-29', to: '2026-10-29' }), 'by Thu, 29 Oct');
  assert.equal(arrival({ from: '2026-10-31', to: '2026-11-04' }), 'between Sat, 31 Oct and Wed, 4 Nov');
});

test('an order keeps the delivery dates its address was promised, and the confirmation says them', async () => {
  const now = new Date();
  const placed = await order('560001'); // everywhere else: 3–7 days
  assert.deepEqual(placed.deliveryEstimate, { from: istDate(now, 3), to: istDate(now, 7) });
  const mail = t.mail.sent.findLast((m) => m.to.email === 'customer@example.com');
  assert.match(mail.text, new RegExp(`It should arrive ${arrival(placed.deliveryEstimate)}\\.`));

  // A faster area: next day.
  assert.equal(
    (
      await admin('POST', '/admin/delivery/zones', {
        prefix: '400',
        name: 'Mumbai',
        deliverable: true,
        minDays: 1,
        maxDays: 1,
      })
    ).status,
    201,
  );
  const fast = await order('400001');
  assert.deepEqual(fast.deliveryEstimate, { from: istDate(now, 1), to: istDate(now, 1) });
  // Changing the area later doesn't change what the order was promised.
  await t.db.collection('deliveryZones').updateOne({ prefix: '400' }, { $set: { minDays: 5, maxDays: 9 } });
  assert.deepEqual((await customer('GET', `/orders/${fast.id}`)).body.deliveryEstimate, fast.deliveryEstimate);
});

test('the dashboard counts orders past their delivery date that haven’t arrived', async () => {
  const late = await order('560001');
  const done = await order('560001');
  const past = { from: '2026-01-01', to: '2026-01-02' };
  await t.db
    .collection('orders')
    .updateMany({ number: { $in: [late.number, done.number] } }, { $set: { deliveryEstimate: past } });
  for (const status of ['shipped', 'delivered']) await admin('POST', `/admin/orders/${done.id}/status`, { status });
  assert.equal((await admin('GET', '/admin/dashboard')).body.lateOrders, 1);
});
