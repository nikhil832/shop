import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let packer;
let support;
let customer;
let order;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  packer = await register('packer@example.com', 'Pooja Packer');
  support = await register('support@example.com', 'Sunil Support');
  customer = await register('asha@example.com', 'Asha Rao');
  const book = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const items = [{ productId: book._id.toString(), qty: 1 }];
  const quote = await customer('GET', `/cart?items=${items[0].productId}:1`);
  const address = {
    name: 'Asha Rao',
    phone: '9876543210',
    line1: '12 MG Road',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
  };
  order = (await customer('POST', '/orders', { items, address, expectedTotal: quote.body.total })).body;
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}
const me = async (call) => (await call('GET', '/auth/me')).body.user;

test('admins make existing accounts staff; nobody else can, and admin is never granted here', async () => {
  assert.equal(
    (await customer('POST', '/admin/staff', { email: 'packer@example.com', role: 'packer' })).body.error,
    'Admins only',
  );
  assert.equal((await admin('POST', '/admin/staff', { email: 'nobody@example.com', role: 'packer' })).status, 404);
  assert.equal((await admin('POST', '/admin/staff', { email: 'owner@example.com', role: 'packer' })).status, 409);
  assert.equal((await admin('POST', '/admin/staff', { email: 'asha@example.com', role: 'admin' })).status, 400);

  const added = await admin('POST', '/admin/staff', { email: 'Packer@Example.com', role: 'packer' });
  assert.equal(added.status, 201);
  assert.deepEqual([added.body.role, added.body.email], ['packer', 'packer@example.com']);
  await admin('POST', '/admin/staff', { email: 'support@example.com', role: 'support' });
  assert.deepEqual((await me(packer)).permissions, ['orders.view', 'orders.ship', 'orders.notes']);
  assert.deepEqual((await me(support)).permissions, ['orders.view', 'orders.notes', 'reviews', 'questions', 'help']);
  assert.deepEqual((await me(admin)).permissions, ['*']);
  assert.deepEqual((await me(customer)).permissions, []);

  const list = (await admin('GET', '/admin/staff')).body;
  assert.deepEqual(
    list.items.map((s) => [s.email, s.role]),
    [
      ['owner@example.com', 'admin'],
      ['packer@example.com', 'packer'],
      ['support@example.com', 'support'],
    ],
  );
  assert.equal((await packer('GET', '/admin/staff')).body.error, "Your account can't do this");
  const logged = (await admin('GET', '/admin/activity?area=accounts')).body.items.filter(
    (e) => e.action === 'Made staff',
  );
  assert.equal(logged.length, 2);
});

test('a packer sees and ships orders, and nothing else', async () => {
  assert.equal((await packer('GET', '/admin/orders')).status, 200);
  assert.equal((await packer('GET', `/admin/orders/${order.id}`)).body.address.line1, '12 MG Road');
  assert.equal((await packer('GET', `/admin/orders?ids=${order.id}`)).status, 200); // packing slips
  assert.equal(
    (await packer('POST', `/admin/orders/${order.id}/notes`, { text: 'Fragile', onSlip: true })).status,
    201,
  );
  const cancel = await packer('POST', `/admin/orders/${order.id}/status`, { status: 'cancelled' });
  assert.equal(cancel.status, 403);
  assert.equal(cancel.body.error, 'Only an admin can cancel an order');
  const shipped = await packer('POST', `/admin/orders/${order.id}/status`, {
    status: 'shipped',
    shipment: { courier: 'BlueDart', trackingNumber: 'BD123' },
  });
  assert.equal(shipped.status, 200, JSON.stringify(shipped.body));
  assert.equal((await packer('PUT', `/admin/orders/${order.id}/shipment`, { courier: 'Delhivery' })).status, 200);
  assert.equal((await packer('POST', '/admin/orders/ship', { ids: [order.id] })).status, 200);
  // The activity log says who.
  const entry = (await admin('GET', '/admin/activity?area=orders')).body.items.find(
    (e) => e.action === 'Marked shipped',
  );
  assert.equal(entry.by.name, 'Pooja Packer');

  for (const [method, path] of [
    ['GET', '/admin/dashboard'],
    ['GET', '/admin/products'],
    ['GET', '/admin/categories'],
    ['GET', '/admin/reviews'],
    ['GET', '/admin/questions'],
    ['GET', '/admin/help'],
    ['GET', '/admin/returns'],
    ['GET', '/admin/coupons'],
    ['GET', '/admin/activity'],
    ['GET', '/admin/orders/export'],
    ['GET', '/admin/products/export'],
    ['POST', `/admin/orders/${order.id}/refund`],
    ['POST', '/admin/ai/answer-draft'],
    ['PATCH', '/admin/products/000000000000000000000000'],
  ]) {
    assert.equal((await packer(method, path, method === 'GET' ? undefined : {})).status, 403, `${method} ${path}`);
  }
});

test('support answers customers and sees orders, but ships nothing', async () => {
  for (const path of [
    '/admin/questions',
    '/admin/help',
    '/admin/reviews',
    '/admin/orders',
    `/admin/orders/${order.id}`,
  ]) {
    assert.equal((await support('GET', path)).status, 200, path);
  }
  assert.equal((await support('GET', '/admin/ai')).status, 200);
  assert.equal((await support('POST', `/admin/orders/${order.id}/status`, { status: 'delivered' })).status, 403);
  assert.equal((await support('POST', '/admin/orders/ship', { ids: [order.id] })).status, 403);
  for (const path of ['/admin/dashboard', '/admin/products', '/admin/staff', '/admin/review-summaries']) {
    assert.equal((await support('GET', path)).status, 403, path);
  }
  assert.equal((await support('POST', '/admin/ai/product-draft', {})).status, 403);
});

test('roles change or go at once; admins stay admins; staff get new-browser alerts and keep their accounts', async () => {
  const packerId = (await me(packer)).id;
  assert.equal((await admin('PATCH', `/admin/staff/${packerId}`, { role: 'support' })).status, 200);
  assert.equal((await packer('GET', '/admin/help')).status, 200); // same session, new role
  assert.equal((await admin('PATCH', `/admin/staff/${packerId}`, { role: 'user' })).body.role, 'user');
  assert.equal((await packer('GET', '/admin/orders')).body.error, 'Admins only');
  assert.equal((await admin('PATCH', `/admin/staff/${(await me(admin)).id}`, { role: 'user' })).status, 409);
  assert.equal((await admin('PATCH', `/admin/staff/${(await me(customer)).id}`, { role: 'packer' })).status, 409);
  assert.equal((await admin('PATCH', '/admin/staff/000000000000000000000000', { role: 'packer' })).status, 404);
  const actions = (await admin('GET', '/admin/activity?area=accounts')).body.items.map((e) => e.action);
  assert.ok(actions.includes('Changed staff role') && actions.includes('Removed from staff'));

  // A staff login from a new browser alerts them, like an admin's.
  const fresh = t.browser();
  assert.equal(
    (await fresh('POST', '/auth/login', { email: 'support@example.com', password: 'password123' })).status,
    200,
  );
  assert.ok(t.mail.sent.some((m) => m.to.email === 'support@example.com' && m.subject.startsWith('New login')));
  // And can't close the account while staff.
  const close = await support('POST', '/account/close', { password: 'password123', confirm: true });
  assert.equal(close.status, 409);
  assert.match(close.body.error, /remove the role first/);
});
