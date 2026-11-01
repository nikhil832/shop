import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// Click and collect (stage 146).
let t;
let admin;
let asha;
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  asha = t.browser();
  await asha('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
});
after(() => t.stop());
beforeEach(() => {
  t.mail.sent.length = 0;
});

const POINT = {
  place: {
    name: 'Bazaar Koramangala',
    phone: '9876500000',
    line1: '80 Feet Road, Koramangala',
    city: 'Bengaluru',
    state: 'karnataka',
    pincode: '560034',
  },
  hours: 'Mon–Sat 10 am–7 pm',
};
const book = () => t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' }); // ₹349
let pointId;

test('admins add pickup points, checked like addresses; the shop lists the shown ones', async () => {
  assert.deepEqual((await t.call('GET', '/pickup-points')).body, { items: [] });
  assert.equal((await asha('POST', '/admin/pickup-points', POINT)).status, 403);
  const wrongState = await admin('POST', '/admin/pickup-points', {
    ...POINT,
    place: { ...POINT.place, state: 'Kerala' },
  });
  assert.equal(wrongState.status, 400);
  assert.match(wrongState.body.error, /PIN code 560034 is in Karnataka/);
  assert.equal((await admin('POST', '/admin/pickup-points', { ...POINT, hours: '' })).status, 400);

  const res = await admin('POST', '/admin/pickup-points', POINT);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.state, 'Karnataka');
  pointId = res.body.id;
  const hidden = await admin('POST', '/admin/pickup-points', {
    ...POINT,
    place: { ...POINT.place, name: 'Old shop' },
    active: false,
  });
  assert.equal(hidden.status, 201);
  assert.deepEqual(
    (await t.call('GET', '/pickup-points')).body.items.map((p) => p.name),
    ['Bazaar Koramangala'],
  );
  const log = await t.db.collection('activity').findOne({ action: 'Added pickup point' });
  assert.equal(log.area, 'delivery');
  // At most 5 shown.
  for (let i = 0; i < 4; i++) {
    await admin('POST', '/admin/pickup-points', { ...POINT, place: { ...POINT.place, name: `Shop ${i}` } });
  }
  const sixth = await admin('POST', '/admin/pickup-points', { ...POINT, place: { ...POINT.place, name: 'Shop 6' } });
  assert.equal(sixth.status, 409);
  await t.db.collection('pickupPoints').updateMany({ name: /^Shop / }, { $set: { active: false } });
});

test('a pickup order is free to deliver, uses the point address, and has a code only the customer sees', async () => {
  const b = await book();
  const quote = (await asha('GET', `/cart?items=${b._id}:1&pickup=1`)).body;
  assert.equal(quote.delivery, 0); // ₹349 would pay ₹40 delivered
  assert.equal((await asha('GET', `/cart?items=${b._id}:1`)).body.delivery, 4000);

  const missing = await asha('POST', '/orders', {
    items: [{ productId: b._id.toString(), qty: 1 }],
    pickupPointId: pointId,
    expectedTotal: quote.total,
  });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /name and phone/);

  const placed = await asha('POST', '/orders', {
    items: [{ productId: b._id.toString(), qty: 1 }],
    pickupPointId: pointId,
    contact: { name: 'Asha Rao', phone: '9876543210' },
    expectedTotal: quote.total,
  });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const order = placed.body;
  assert.equal(order.delivery, 0);
  assert.equal(order.deliveryEstimate, null);
  assert.equal(order.pickup.name, 'Bazaar Koramangala');
  assert.match(order.pickup.code, /^\d{6}$/);
  assert.equal(order.address.name, 'Asha Rao');
  assert.equal(order.address.line1, '80 Feet Road, Koramangala');
  assert.equal(order.address.state, 'Karnataka');
  // Not saved to the address book.
  assert.deepEqual((await asha('GET', '/auth/me')).body.user.addresses, []);
  assert.match(
    t.mail.sent.find((m) => m.to.email === 'asha@example.com').text,
    /You'll collect it from Bazaar Koramangala/,
  );
  // Admins never see the code.
  const adminView = (await admin('GET', `/admin/orders/${order.id}`)).body;
  assert.equal(adminView.pickup.name, 'Bazaar Koramangala');
  assert.equal(adminView.pickup.code, undefined);
  // No address to change.
  const change = await asha('POST', `/orders/${order.id}/address`, {
    name: 'Asha Rao',
    phone: '9876543210',
    line1: '12 MG Road',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
  });
  assert.equal(change.status, 409);

  // Ready for pickup: the email has the code. Collected only with it.
  t.mail.sent.length = 0;
  assert.equal((await admin('POST', `/admin/orders/${order.id}/status`, { status: 'shipped' })).status, 200);
  const ready = t.mail.sent.find((m) => m.to.email === 'asha@example.com');
  assert.match(ready.subject, /is ready for pickup$/);
  assert.match(ready.text, new RegExp(`Your pickup code is ${order.pickup.code}`));
  const none = await admin('POST', `/admin/orders/${order.id}/status`, { status: 'delivered' });
  assert.equal(none.status, 400);
  assert.match(none.body.error, /Enter the customer's pickup code/);
  const wrong = order.pickup.code === '000000' ? '111111' : '000000';
  const bad = await admin('POST', `/admin/orders/${order.id}/status`, { status: 'delivered', pickupCode: wrong });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /doesn't match/);
  const done = await admin('POST', `/admin/orders/${order.id}/status`, {
    status: 'delivered',
    pickupCode: order.pickup.code,
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, 'delivered');
  const log = await t.db.collection('activity').findOne({ action: 'Marked collected' });
  assert.ok(log);
});

test('a hidden point refuses orders; ordinary delivered orders need no code', async () => {
  const b = await book();
  await admin('PUT', `/admin/pickup-points/${pointId}`, { ...POINT, active: false });
  const q = (await asha('GET', `/cart?items=${b._id}:1&pickup=1`)).body;
  const refused = await asha('POST', '/orders', {
    items: [{ productId: b._id.toString(), qty: 1 }],
    pickupPointId: pointId,
    contact: { name: 'Asha Rao', phone: '9876543210' },
    expectedTotal: q.total,
  });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /no longer available/);

  const quote = (await asha('GET', `/cart?items=${b._id}:1`)).body;
  const placed = await asha('POST', '/orders', {
    items: [{ productId: b._id.toString(), qty: 1 }],
    address: {
      name: 'Asha Rao',
      phone: '9876543210',
      line1: '12 MG Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
    },
    expectedTotal: quote.total,
  });
  assert.equal(placed.status, 201);
  assert.equal(placed.body.pickup, null);
  await admin('POST', `/admin/orders/${placed.body.id}/status`, { status: 'shipped' });
  assert.equal((await admin('POST', `/admin/orders/${placed.body.id}/status`, { status: 'delivered' })).status, 200);
});
