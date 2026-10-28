import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let packer;
let asha;
let ravi;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  packer = await register('packer@example.com', 'Pooja Packer');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  await t.db.collection('users').updateOne({ email: 'packer@example.com' }, { $set: { role: 'packer' } });
  asha = await register('asha@example.com', 'Asha Rao');
  ravi = await register('ravi@example.com', 'Ravi Kumar');
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  call.id = (await call('GET', '/auth/me')).body.user.id;
  return call;
}

const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
async function order(call, slug, qty = 1) {
  const p = await t.db.collection('products').findOne({ slug });
  const quote = await call('GET', `/cart?items=${p._id}:${qty}`);
  const res = await call('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty }],
    address,
    expectedTotal: quote.body.total,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
const list = async (query = '') => {
  const res = await admin('GET', `/admin/customers${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

test('lists accounts with what each has bought; cancelled orders and refunds don’t count', async () => {
  await order(asha, 'orbit-a14-4gb-ram-64gb'); // ₹8,999
  const cancelled = await order(asha, 'the-quiet-engineer-paperback'); // ₹389, then cancelled
  await asha('POST', `/orders/${cancelled.id}/cancel`);
  await order(ravi, 'the-quiet-engineer-paperback'); // ₹389

  const bySpent = await list('?sort=spent');
  const row = (email) => bySpent.items.find((c) => c.email === email);
  assert.deepEqual([row('asha@example.com').orders, row('asha@example.com').spent], [1, 899900]);
  assert.deepEqual([row('ravi@example.com').orders, row('ravi@example.com').spent], [1, 38900]);
  assert.deepEqual([row('packer@example.com').orders, row('packer@example.com').role], [0, 'packer']);
  assert.equal(bySpent.items[0].email, 'asha@example.com');
  assert.equal(bySpent.total, 4);

  // Newest account first by default; the latest order first when asked.
  assert.equal((await list()).items[0].email, 'ravi@example.com');
  const byOrder = await list('?sort=last_order');
  assert.deepEqual(
    byOrder.items.slice(0, 2).map((c) => c.email),
    ['ravi@example.com', 'asha@example.com'],
  );
});

test('searches by name or email, as typed (no patterns)', async () => {
  assert.deepEqual(
    (await list('?q=kumar')).items.map((c) => c.name),
    ['Ravi Kumar'],
  );
  assert.deepEqual(
    (await list('?q=ASHA@')).items.map((c) => c.email),
    ['asha@example.com'],
  );
  assert.equal((await list('?q=.*')).total, 0);
  assert.equal((await admin('GET', '/admin/customers?sort=oldest')).status, 400);
});

test("one customer's page: details, totals, orders, returns, help requests and credit", async () => {
  await t.db.collection('rateLimits').deleteMany({});
  await asha('POST', '/help', { topic: 'other', message: 'Can I change my delivery address?' });
  const page = await admin('GET', `/admin/customers/${asha.id}`);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  const { customer, totals, orders, help, returns, credit } = page.body;
  assert.equal(customer.name, 'Asha Rao');
  assert.equal(customer.addresses[0].city, 'Bengaluru');
  assert.equal(customer.twoStep, false);
  assert.deepEqual([totals.orders, totals.allOrders, totals.spent, totals.refunded], [1, 2, 899900, 0]);
  assert.deepEqual(
    orders.map((o) => o.status),
    ['cancelled', 'placed'],
  );
  assert.equal(help[0].messages, 1);
  assert.deepEqual([returns, credit], [[], []]);
  // Nothing private leaves: no password hash or two-step secret.
  assert.ok(!JSON.stringify(page.body).includes('scrypt$'));
  assert.equal((await admin('GET', '/admin/customers/000000000000000000000000')).status, 404);
});

test('admins give store credit from the customer page; it is logged and emailed', async () => {
  const res = await admin('POST', `/admin/customers/${ravi.id}/credit`, { amount: 20000, note: 'Welcome back' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.balance, 20000);
  assert.equal((await ravi('GET', '/auth/me')).body.user.credit, 20000);
  const page = (await admin('GET', `/admin/customers/${ravi.id}`)).body;
  assert.deepEqual(
    page.credit.map((c) => [c.reason, c.change, c.note]),
    [['goodwill', 20000, 'Welcome back']],
  );
  const logged = await t.db.collection('activity').findOne({ action: 'Added store credit' });
  assert.deepEqual(logged.target, { label: 'Ravi Kumar', path: `/admin/customers/${ravi.id}` });
  assert.ok(t.mail.sent.some((m) => m.to.email === 'ravi@example.com' && m.subject.includes('store credit')));
  assert.equal((await admin('POST', `/admin/customers/${ravi.id}/credit`, { amount: 150, note: 'Hi' })).status, 400);
});

test('admins only', async () => {
  for (const [method, path] of [
    ['GET', '/admin/customers'],
    ['GET', `/admin/customers/${asha.id}`],
    ['POST', `/admin/customers/${asha.id}/credit`],
  ]) {
    assert.equal((await t.call(method, path, method === 'POST' ? {} : undefined)).status, 401, path);
    assert.equal((await asha(method, path, method === 'POST' ? {} : undefined)).status, 403, path);
    assert.equal((await packer(method, path, method === 'POST' ? {} : undefined)).status, 403, path);
  }
});
