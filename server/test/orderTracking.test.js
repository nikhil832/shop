import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let placed;
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  const customer = t.browser();
  await customer('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
  const book = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const quote = await customer('GET', `/cart?items=${book._id}:2`);
  placed = (
    await customer('POST', '/orders', {
      items: [{ productId: book._id.toString(), qty: 2 }],
      address: {
        name: 'Ravi Kumar',
        phone: '9876543210',
        line1: '12 MG Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560001',
      },
      expectedTotal: quote.body.total,
    })
  ).body;
});
after(() => t.stop());
// Every test request comes from localhost: one network's hourly limit.
beforeEach(() => t.db.collection('rateLimits').deleteMany({}));

const track = (number, pincode) => t.call('POST', '/track', { number, pincode });

test('the order number and its PIN code show where it is, and nothing private', async () => {
  const res = await track(placed.number, '560001');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'placed');
  assert.deepEqual(res.body.items, [{ title: 'The Quiet Engineer (Paperback)', qty: 2 }]);
  assert.ok(res.body.deliveryEstimate.from);
  const text = JSON.stringify(res.body);
  for (const secret of ['Ravi', '9876543210', 'MG Road', 'total', 'price', 'payment', 'asha']) {
    assert.ok(!text.includes(secret), secret);
  }

  // Shipped with tracking: the courier's details come too.
  await admin('POST', `/admin/orders/${placed.id}/status`, {
    status: 'shipped',
    shipment: { courier: 'Delhivery', trackingNumber: 'DL123', trackingUrl: 'https://track.example/DL123' },
  });
  const shipped = (await track(String(placed.number), ' 560001 ')).body;
  assert.equal(shipped.status, 'shipped');
  assert.equal(shipped.shipment.trackingNumber, 'DL123');
  assert.ok(shipped.shippedAt);
});

test('a wrong PIN code and a wrong number get the same answer; tries are limited', async () => {
  const wrongPin = await track(placed.number, '560002');
  const wrongNumber = await track(placed.number + 999, '560001');
  assert.equal(wrongPin.status, 404);
  assert.deepEqual(wrongPin.body, wrongNumber.body);
  assert.equal((await track('abc', '560001')).status, 400);
  assert.equal((await track(placed.number, '5600')).status, 400);
  // Badly formed ones aren't counted: 2 + 18 = 20 tries, then no more this hour.
  for (let i = 0; i < 18; i++) await track(placed.number, '560002');
  const limited = await track(placed.number, '560001');
  assert.equal(limited.status, 429);
});
