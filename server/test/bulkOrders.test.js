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
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}

async function placeOrder(slug = 'the-quiet-engineer-paperback') {
  const p = await t.db.collection('products').findOne({ slug });
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
const shipMany = (ids) => admin('POST', '/admin/orders/ship', { ids });
const shippedMails = () =>
  t.mail.sent.filter((m) => m.to.email === 'asha@example.com' && / has shipped$/.test(m.subject));

test('the packing slips page gets the chosen orders, in the order asked', async () => {
  const a = await placeOrder();
  const b = await placeOrder('orbit-a14-4gb-ram-64gb');
  const res = await admin('GET', `/admin/orders?ids=${b.id},${a.id},${b.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.items.map((o) => o.id),
    [b.id, a.id],
  );
  assert.equal(res.body.items[0].customer.email, 'asha@example.com');
  assert.equal(res.body.items[0].address.city, 'Bengaluru');
  assert.equal((await admin('GET', '/admin/orders?ids=nope')).status, 400);
  const tooMany = Array.from({ length: 51 }, (_, i) => i.toString(16).padStart(24, '0')).join(',');
  assert.match((await admin('GET', `/admin/orders?ids=${tooMany}`)).body.error, /At most 50/);
  assert.equal((await customer('GET', `/admin/orders?ids=${a.id}`)).status, 403);
});

test('several orders are shipped at once, each emailed and logged; the rest are skipped with a reason', async () => {
  const one = await placeOrder();
  const two = await placeOrder();
  const delivered = await placeOrder();
  await admin('POST', `/admin/orders/${delivered.id}/status`, { status: 'shipped' });
  await admin('POST', `/admin/orders/${delivered.id}/status`, { status: 'delivered' });
  const cancelled = await placeOrder();
  await customer('POST', `/orders/${cancelled.id}/cancel`);
  const mailsBefore = shippedMails().length;

  const res = await shipMany([one.id, two.id, delivered.id, cancelled.id, '0123456789abcdef01234567']);
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.shipped.map((s) => s.number),
    [one.number, two.number],
  );
  assert.deepEqual(
    res.body.skipped.map((s) => [s.number, s.reason]),
    [
      [delivered.number, "A delivered order can't be marked shipped"],
      [cancelled.number, "A cancelled order can't be marked shipped"],
      [null, 'Order not found'],
    ],
  );
  for (const o of [one, two]) {
    assert.equal((await admin('GET', `/admin/orders/${o.id}`)).body.status, 'shipped');
  }
  assert.equal(shippedMails().length, mailsBefore + 2);
  const log = (await admin('GET', '/admin/activity?area=orders')).body.items;
  assert.deepEqual(
    log.slice(0, 2).map((e) => e.target.label),
    [`Order #${two.number}`, `Order #${one.number}`],
  );

  // Again: both are shipped now, so both are skipped and nobody is emailed twice.
  const again = await shipMany([one.id, two.id]);
  assert.deepEqual(again.body.shipped, []);
  assert.equal(again.body.skipped.length, 2);
  assert.equal(shippedMails().length, mailsBefore + 2);
});

test('bulk shipping is for admins, with a list of up to 50 orders', async () => {
  const o = await placeOrder();
  assert.equal((await customer('POST', '/admin/orders/ship', { ids: [o.id] })).status, 403);
  assert.equal((await t.call('POST', '/admin/orders/ship', { ids: [o.id] })).status, 401);
  assert.match((await shipMany([])).body.error, /Choose some orders/);
  assert.equal((await shipMany(['nope'])).status, 400);
  assert.equal((await shipMany(Array.from({ length: 51 }, () => o.id))).status, 400);
});
