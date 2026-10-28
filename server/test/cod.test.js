import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let packer;
before(async () => {
  t = await startTestServer({ razorpay: true });
  admin = await register('owner@example.com', 'Store Owner');
  packer = await register('packer@example.com', 'Pooja Packer');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  await t.db.collection('users').updateOne({ email: 'packer@example.com' }, { $set: { role: 'packer' } });
});
after(() => t.stop());
beforeEach(() => t.db.collection('settings').deleteOne({ _id: 'cod' }));

let n = 0;
async function register(email = `buyer${++n}@example.com`, name = 'Asha Rao') {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  call.email = email;
  call.id = (await call('GET', '/auth/me')).body.user.id;
  return call;
}

const BOOK = 'the-quiet-engineer-paperback'; // ₹349 + ₹40 delivery
const PHONE = 'orbit-a14-4gb-ram-64gb'; // ₹8,999
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
const product = (slug) => t.db.collection('products').findOne({ slug });
function place(call, slug, { qty = 1, online = false } = {}) {
  return (async () => {
    const p = await product(slug);
    const quote = await call('GET', `/cart?items=${p._id}:${qty}`);
    return call('POST', '/orders', {
      items: [{ productId: p._id.toString(), qty }],
      address,
      expectedTotal: quote.body.total,
      paymentMethod: online ? 'razorpay' : 'cod',
    });
  })();
}
async function shipped(call, slug, opts) {
  const res = await place(call, slug, opts);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  let order = res.body;
  if (opts?.online) {
    const { response } = t.fake.pay(order.payment.razorpayOrderId);
    order = (await call('POST', `/orders/${order.id}/payment`, response)).body;
  }
  assert.equal((await admin('POST', `/admin/orders/${order.id}/status`, { status: 'shipped' })).status, 200);
  return order;
}
const returned = (order, reason = 'refused', note = '') =>
  admin('POST', `/admin/orders/${order.id}/returned`, { reason, note });

test('a shipped order that comes back undelivered is cancelled, its stock back and the customer told why', async () => {
  const call = await register();
  const before = (await product(BOOK)).stock;
  const order = await shipped(call, BOOK);
  const res = await returned(order, 'refused', 'Door shut, said not ordered');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'cancelled');
  assert.equal(res.body.returnedToSender.reason, 'refused');
  assert.equal(res.body.returnedToSender.note, 'Door shut, said not ordered');
  assert.equal((await product(BOOK)).stock, before);
  // Recorded in the stock history as such.
  const history = await t.db.collection('stockHistory').find({ reason: 'returned_to_sender' }).toArray();
  assert.deepEqual(
    history.map((h) => [h.change, h.orderNumber]),
    [[1, order.number]],
  );

  // The customer sees why, but not the admin's note.
  const mine = (await call('GET', `/orders/${order.id}`)).body;
  assert.deepEqual(Object.keys(mine.returnedToSender).sort(), ['at', 'reason']);
  const mail = t.mail.sent.findLast((m) => m.to.email === call.email);
  assert.match(mail.text, /came back to us undelivered \(it was refused at the door\)/);
  const logged = await t.db.collection('activity').findOne({ action: 'Returned to sender' });
  assert.equal(logged.changes[0].to, 'Refused by the customer');
});

test('only shipped orders can come back, only admins mark them, and the reason is checked', async () => {
  const call = await register();
  const placed = (await place(call, BOOK)).body;
  assert.equal((await returned(placed)).status, 409);
  const order = await shipped(call, BOOK);
  assert.equal((await packer('POST', `/admin/orders/${order.id}/returned`, { reason: 'refused' })).status, 403);
  assert.equal((await returned(order, 'lost')).status, 400);
  assert.equal((await returned(order)).status, 200);
  assert.equal((await returned(order)).status, 409);
});

test('a paid online order that comes back is refunded', async () => {
  const call = await register();
  const order = await shipped(call, BOOK, { online: true });
  const res = await returned(order, 'address');
  assert.equal(res.body.payment.status, 'refunded');
  assert.equal(t.fake.state.refunds.at(-1).amount, 38900);
});

test('after 2 COD orders refused or unreachable, a customer must pay online, until an admin allows COD again', async () => {
  const call = await register();
  // A wrong address isn't the customer's doing: it doesn't count.
  await returned(await shipped(call, BOOK), 'address');
  await returned(await shipped(call, BOOK), 'refused');
  assert.equal((await call('GET', '/payments/options')).body.cod, true);
  await returned(await shipped(call, BOOK), 'unreachable');

  const options = (await call('GET', '/payments/options')).body;
  assert.equal(options.cod, false);
  assert.match(options.codReason, /came back undelivered/);
  const refused = await place(call, BOOK);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /please pay online/);
  // Paying online still works.
  assert.equal((await place(call, BOOK, { online: true })).status, 201);
  // Others aren't affected.
  const other = await register();
  assert.equal((await other('GET', '/payments/options')).body.cod, true);

  const page = (await admin('GET', `/admin/customers/${call.id}`)).body;
  assert.deepEqual(page.cod, { refused: 2, allowed: false });
  assert.equal((await admin('POST', `/admin/cod/forgive/${call.id}`)).status, 204);
  assert.equal((await call('GET', '/payments/options')).body.cod, true);
  assert.equal((await place(call, BOOK)).status, 201);
  assert.ok(await t.db.collection('activity').findOne({ action: 'Allowed Cash on Delivery again' }));
});

test('admins set a COD order limit and how many refusals; "none" switches each off', async () => {
  assert.deepEqual((await admin('GET', '/admin/cod')).body, { maxOrder: null, refusedLimit: 2 });
  const saved = await admin('PUT', '/admin/cod', { maxOrder: 500000, refusedLimit: 3 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const call = await register();
  assert.equal((await call('GET', '/payments/options')).body.codMax, 500000);
  const big = await place(call, PHONE); // ₹8,999 on delivery
  assert.equal(big.status, 409);
  assert.match(big.body.error, /Cash on Delivery is for orders up to ₹5,000/);
  assert.equal((await place(call, BOOK)).status, 201);
  assert.equal((await place(call, PHONE, { online: true })).status, 201);

  for (const [body, error] of [
    [{ maxOrder: 5000, refusedLimit: 2 }, 'From ₹100'],
    [{ maxOrder: 100050, refusedLimit: 2 }, 'whole rupees'],
    [{ maxOrder: null, refusedLimit: 0 }, 'From 1 to 10'],
  ]) {
    const res = await admin('PUT', '/admin/cod', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.error.includes(error), `${res.body.error} / ${error}`);
  }
  assert.equal((await admin('PUT', '/admin/cod', { maxOrder: null, refusedLimit: null })).status, 200);
  assert.equal((await place(call, PHONE)).status, 201);
  const log = await t.db.collection('activity').findOne({ action: 'Changed Cash on Delivery rules' });
  assert.deepEqual(log.changes[0], { field: 'Cash on Delivery up to', from: 'No limit', to: '₹5,000' });
  assert.equal((await packer('GET', '/admin/cod')).status, 403);
});
