import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  customer = t.browser();
  await customer('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
});
after(() => t.stop());

const bookId = async () =>
  (await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' }))._id.toString();
const meghalaya = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: 'Police Bazaar',
  city: 'Shillong',
  state: 'Meghalaya',
  pincode: '793001',
};

test('an area can add a delivery charge (checked, logged, shown with the PIN check)', async () => {
  for (const [extraCharge, error] of [
    [6050, 'Whole rupees only'],
    [60000, 'At most ₹500'],
  ]) {
    const res = await admin('POST', '/admin/delivery/zones', {
      prefix: '79',
      name: 'North East',
      deliverable: true,
      minDays: 5,
      maxDays: 9,
      extraCharge,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, new RegExp(error));
  }
  const zone = await admin('POST', '/admin/delivery/zones', {
    prefix: '79',
    name: 'North East',
    deliverable: true,
    minDays: 5,
    maxDays: 9,
    extraCharge: 6000,
  });
  assert.equal(zone.status, 201, JSON.stringify(zone.body));
  assert.equal(zone.body.extraCharge, 6000);
  const log = await t.db.collection('activity').findOne({ action: 'Added delivery area' });
  assert.equal(log.target.label, '79 (North East), 5–9 days, +₹60');

  const check = await t.call('GET', '/delivery?pincode=793001');
  assert.equal(check.body.extraCharge, 6000);
  assert.equal((await t.call('GET', '/delivery?pincode=560001')).body.extraCharge, 0);
});

test('the quote and the order add it to delivery, even when delivery is otherwise free', async () => {
  const id = await bookId();
  const plain = (await customer('GET', `/cart?items=${id}:1`)).body;
  assert.equal(plain.delivery, 4000);
  assert.equal(plain.deliveryExtra, 0);
  const far = (await customer('GET', `/cart?items=${id}:1&pincode=793001`)).body;
  assert.equal(far.delivery, 4000 + 6000);
  assert.equal(far.deliveryExtra, 6000);
  assert.equal(far.total, plain.total + 6000);

  // Two books: free delivery, but the area's charge stays.
  const two = (await customer('GET', `/cart?items=${id}:2&pincode=793001`)).body;
  assert.equal(two.delivery, 6000);

  // The order must have been shown the charge.
  const order = (expectedTotal) =>
    customer('POST', '/orders', { items: [{ productId: id, qty: 2 }], address: meghalaya, expectedTotal });
  assert.equal((await order(two.total - 6000)).status, 409);
  const res = await order(two.total);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.delivery, 6000);
  assert.equal(res.body.deliveryExtra, 6000);
  assert.equal(res.body.total, 69800 + 6000);
});

test('"everywhere else" can have a charge too', async () => {
  const res = await admin('PUT', '/admin/delivery/everywhere-else', {
    deliverable: true,
    minDays: 3,
    maxDays: 7,
    extraCharge: 2000,
  });
  assert.equal(res.status, 200);
  assert.equal((await t.call('GET', '/delivery?pincode=560001')).body.extraCharge, 2000);
  assert.equal((await admin('GET', '/admin/delivery')).body.everywhereElse.extraCharge, 2000);
  await admin('PUT', '/admin/delivery/everywhere-else', { deliverable: true, minDays: 3, maxDays: 7 });
  assert.equal((await t.call('GET', '/delivery?pincode=560001')).body.extraCharge, 0);
});
