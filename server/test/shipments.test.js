import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'Store Admin');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  customer = await register('asha@example.com', 'Asha Rao');
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name, email, password: 'password123' });
  assert.equal(res.status, 201);
  return call;
}

async function placeOrder() {
  const p = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const quote = await customer('GET', `/cart?items=${p._id}:1`);
  const res = await customer('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty: 1 }],
    address: {
      name: 'Asha Rao',
      phone: '9876543210',
      line1: '12 MG Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
    },
    expectedTotal: quote.body.total,
  });
  assert.equal(res.status, 201);
  return res.body;
}
const ship = (order, shipment) => admin('POST', `/admin/orders/${order.id}/status`, { status: 'shipped', shipment });
const shippedMail = (order) =>
  t.mail.sent.findLast((m) => m.to.email === 'asha@example.com' && m.subject === `Order #${order.number} has shipped`);

const TRACKING = {
  courier: 'Delhivery',
  trackingNumber: 'DLV 1234-5678',
  trackingUrl: 'https://www.example-courier.in/track/DLV12345678',
};

test('shipping with a courier and tracking number shows them to the customer and in the email', async () => {
  const order = await placeOrder();
  const res = await ship(order, TRACKING);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.shipment, TRACKING);

  const mine = (await customer('GET', `/orders/${order.id}`)).body;
  assert.deepEqual(mine.shipment, TRACKING);

  const mail = shippedMail(order);
  assert.match(mail.text, /It's travelling with Delhivery, tracking number DLV 1234-5678\./);
  assert.match(mail.text, /Track your parcel: https:\/\/www\.example-courier\.in\/track\/DLV12345678/);
  assert.match(mail.html, /Track your parcel/);
});

test('tracking is optional, and can be added or corrected later while shipped or delivered', async () => {
  const order = await placeOrder();
  // Shipping without details works as before: no shipment, and an email without tracking lines.
  const shipped = await ship(order);
  assert.equal(shipped.body.shipment, null);
  assert.doesNotMatch(shippedMail(order).text, /travelling with|Track your parcel/);

  const added = await admin('PUT', `/admin/orders/${order.id}/shipment`, {
    courier: 'India Post',
    trackingNumber: 'EE123456789IN',
  });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.shipment, { courier: 'India Post', trackingNumber: 'EE123456789IN', trackingUrl: '' });
  // Editing sends nothing.
  const sent = t.mail.sent.length;
  assert.equal((await admin('PUT', `/admin/orders/${order.id}/shipment`, TRACKING)).status, 200);
  assert.equal(t.mail.sent.length, sent);

  await admin('POST', `/admin/orders/${order.id}/status`, { status: 'delivered' });
  const cleared = await admin('PUT', `/admin/orders/${order.id}/shipment`, { courier: '', trackingNumber: '' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.shipment, null);
  assert.equal((await customer('GET', `/orders/${order.id}`)).body.shipment, null);
});

test('tracking details are checked, and only admins edit them, only after shipping', async () => {
  const order = await placeOrder();
  for (const [shipment, error] of [
    [{ ...TRACKING, trackingUrl: 'javascript:alert(1)' }, 'shipment.trackingUrl: Paste a link starting with https://'],
    [{ trackingNumber: 'ABC123' }, 'shipment.courier: Name the courier'],
    [
      { courier: 'Delhivery', trackingNumber: 'AB<script>' },
      'shipment.trackingNumber: Use letters, digits, spaces and dashes',
    ],
    [{ courier: 'x'.repeat(41) }, null],
  ]) {
    const res = await ship(order, shipment);
    assert.equal(res.status, 400, JSON.stringify(shipment));
    if (error) assert.equal(res.body.error, error);
  }
  // Nothing was shipped by the refused attempts.
  assert.equal((await customer('GET', `/orders/${order.id}`)).body.status, 'placed');

  // The edit route names the fields without the "shipment." in front.
  const badLink = await admin('PUT', `/admin/orders/${order.id}/shipment`, { trackingUrl: 'ftp://x' });
  assert.equal(badLink.body.error, 'trackingUrl: Paste a link starting with https://');
  const early = await admin('PUT', `/admin/orders/${order.id}/shipment`, TRACKING);
  assert.equal(early.status, 409);
  assert.equal(early.body.error, 'A placed order has no shipment to edit');
  assert.equal((await customer('PUT', `/admin/orders/${order.id}/shipment`, TRACKING)).status, 403);
  assert.equal((await t.call('PUT', `/admin/orders/${order.id}/shipment`, TRACKING)).status, 401);
});
