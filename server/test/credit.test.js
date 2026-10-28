import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { expireUnpaidOrders } from '../src/routes/orders.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let support;
before(async () => {
  t = await startTestServer({ razorpay: true });
  admin = await register('owner@example.com', 'Store Owner');
  support = await register('support@example.com', 'Sam Support');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  await t.db.collection('users').updateOne({ email: 'support@example.com' }, { $set: { role: 'support' } });
});
after(() => t.stop());

let n = 0;
async function register(email = `shopper${++n}@example.com`, name = 'Asha Rao') {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  call.email = email;
  return call;
}

const BOOK = 'the-quiet-engineer-paperback'; // ₹349 + ₹40 delivery
const PHONE = 'orbit-a14-4gb-ram-64gb'; // ₹8,999, free delivery
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
const product = (slug) => t.db.collection('products').findOne({ slug });
const balance = async (call) => (await call('GET', '/auth/me')).body.user.credit;
const ledger = async (call) => (await call('GET', '/account/credit')).body;

// A customer with `amount` paise of goodwill credit, given by the admin from their help request.
async function customerWithCredit(amount) {
  const call = await register();
  // The help form allows 5 requests an hour per network, and every test request comes from localhost.
  await t.db.collection('rateLimits').deleteMany({});
  const help = await call('POST', '/help', { topic: 'other', message: 'My parcel came late, twice.' });
  assert.equal(help.status, 201, JSON.stringify(help.body));
  const res = await admin('POST', `/admin/help/${help.body.id}/credit`, { amount, note: 'Sorry about the delay' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  call.helpId = help.body.id;
  return call;
}

async function place(call, slug, { qty = 1, creditToUse = 0, online = false } = {}) {
  const p = await product(slug);
  const quote = await call('GET', `/cart?items=${p._id}:${qty}`);
  return call('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty }],
    address,
    expectedTotal: quote.body.total,
    paymentMethod: online ? 'razorpay' : 'cod',
    creditToUse,
  });
}

test('admins add goodwill credit from a help request; the customer is emailed and sees it', async () => {
  const call = await customerWithCredit(50000);
  assert.equal(await balance(call), 50000);
  const mail = t.mail.sent.findLast((m) => m.to.email === call.email);
  assert.equal(mail.subject, '₹500 of store credit for you');
  assert.match(mail.text, /Why: Sorry about the delay/);
  const { balance: shown, items } = await ledger(call);
  assert.equal(shown, 50000);
  assert.deepEqual(
    items.map((e) => [e.reason, e.change, e.balance, e.note]),
    [['goodwill', 50000, 50000, 'Sorry about the delay']],
  );
  const logged = await t.db.collection('activity').findOne({ action: 'Added store credit' });
  assert.equal(logged.changes.find((c) => c.field === 'Amount').to, '₹500');

  // Taken back (a mistake), never below zero.
  const back = await admin('POST', `/admin/help/${call.helpId}/credit`, { amount: -20000, note: 'Added twice' });
  assert.equal(back.body.balance, 30000);
  const tooMuch = await admin('POST', `/admin/help/${call.helpId}/credit`, { amount: -40000, note: 'Oops' });
  assert.equal(tooMuch.status, 409);
  assert.match(tooMuch.body.error, /only ₹300/);
  assert.equal(await balance(call), 30000);
});

test('goodwill is checked, admins only, and needs an account', async () => {
  const call = await customerWithCredit(10000);
  for (const [body, error] of [
    [{ amount: 0, note: 'Nothing' }, 'Enter an amount'],
    [{ amount: 12345, note: 'Paise' }, 'Whole rupees only'],
    [{ amount: 1_000_100, note: 'Too much' }, 'At most ₹10,000'],
    [{ amount: 10000, note: '' }, 'Say why'],
  ]) {
    const res = await admin('POST', `/admin/help/${call.helpId}/credit`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.error.includes(error), `${res.body.error} / ${error}`);
  }
  assert.equal(
    (await support('POST', `/admin/help/${call.helpId}/credit`, { amount: 10000, note: 'Kind' })).status,
    403,
  );
  assert.equal((await call('POST', `/admin/help/${call.helpId}/credit`, { amount: 10000, note: 'Me' })).status, 403);
  assert.equal((await admin('GET', `/admin/help/${call.helpId}/credit`)).body.balance, 10000);

  const guest = await t.call('POST', '/help', {
    topic: 'other',
    message: 'Where is my parcel?',
    name: 'Guest',
    email: 'guest@example.com',
  });
  const res = await admin('POST', `/admin/help/${guest.body.id}/credit`, { amount: 10000, note: 'Kind' });
  assert.equal(res.status, 409);
  assert.equal((await admin('GET', `/admin/help/${guest.body.id}/credit`)).body.balance, null);
});

test('credit pays part of a COD order; the rest is collected on delivery', async () => {
  const call = await customerWithCredit(10000);
  const res = await place(call, BOOK, { creditToUse: 10000 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.total, 38900);
  assert.equal(res.body.creditUsed, 10000);
  assert.deepEqual(res.body.payment, { method: 'cod' });
  assert.equal(await balance(call), 0);
  const [spent] = (await ledger(call)).items;
  assert.deepEqual([spent.reason, spent.change, spent.balance], ['spent', -10000, 0]);
  assert.deepEqual(spent.order, { id: res.body.id, number: res.body.number });
  const mail = t.mail.sent.findLast((m) => m.to.email === call.email);
  assert.match(mail.text, /You'll pay ₹289 in cash/);
  assert.match(mail.text, /Paid with store credit: −₹100/);
});

test('more credit than the customer has, or than the order costs, is refused and nothing changes', async () => {
  const call = await customerWithCredit(10000);
  const before = (await product(BOOK)).stock;
  const orders = await t.db.collection('orders').countDocuments();
  const short = await place(call, BOOK, { creditToUse: 20000 });
  assert.equal(short.status, 409);
  assert.match(short.body.error, /store credit has changed/);
  assert.equal((await place(call, BOOK, { creditToUse: 50000 })).status, 400);
  assert.equal((await product(BOOK)).stock, before);
  assert.equal(await t.db.collection('orders').countDocuments(), orders);
  assert.equal(await balance(call), 10000);
});

test('two orders at once cannot spend the same credit', async () => {
  const call = await customerWithCredit(30000);
  const results = await Promise.all([
    place(call, BOOK, { creditToUse: 30000 }),
    place(call, BOOK, { creditToUse: 30000 }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(await balance(call), 0);
});

test('an order paid in full with credit is placed at once, with nothing to pay', async () => {
  const call = await customerWithCredit(40000);
  const res = await place(call, BOOK, { creditToUse: 38900, online: true });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.status, 'placed');
  assert.deepEqual(res.body.payment, { method: 'credit' });
  assert.equal(res.body.checkout, null);
  assert.equal(await balance(call), 1100);
  const mail = t.mail.sent.findLast((m) => m.to.email === call.email);
  assert.match(mail.text, /paid in full with your store credit/);

  // Cancelled: all of it comes back as credit.
  assert.equal((await call('POST', `/orders/${res.body.id}/cancel`)).status, 200);
  assert.equal(await balance(call), 40000);
  const [back] = (await ledger(call)).items;
  assert.deepEqual([back.reason, back.change], ['cancelled', 38900]);
});

test('online, Razorpay charges only what credit leaves; cancelling refunds that and returns the credit', async () => {
  const call = await customerWithCredit(100000);
  const res = await place(call, PHONE, { creditToUse: 100000, online: true });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.checkout.amount, 899900 - 100000);
  assert.equal(t.fake.state.orders.get(res.body.payment.razorpayOrderId).amount, 799900);
  const { response } = t.fake.pay(res.body.payment.razorpayOrderId);
  const paid = await call('POST', `/orders/${res.body.id}/payment`, response);
  assert.equal(paid.body.status, 'placed');

  const cancelled = await admin('POST', `/admin/orders/${res.body.id}/status`, { status: 'cancelled' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.payment.status, 'refunded');
  const refund = t.fake.state.refunds.find((r) => r.id === cancelled.body.payment.refundId);
  assert.equal(refund.amount, 799900);
  assert.equal(await balance(call), 100000);
  const mail = t.mail.sent.findLast((m) => m.to.email === call.email);
  assert.match(mail.text, /refund of ₹7,999/);
  assert.match(mail.text, /₹1,000 of store credit you used is back/);
});

test('credit spent on an unpaid online order comes back when the order is released', async () => {
  const call = await customerWithCredit(20000);
  const res = await place(call, BOOK, { creditToUse: 20000, online: true });
  assert.equal(await balance(call), 0);
  await t.db
    .collection('orders')
    .updateOne({ number: res.body.number }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  await expireUnpaidOrders(t.ctx);
  assert.equal(await balance(call), 20000);
});

async function delivered(call, order) {
  for (const status of ['shipped', 'delivered']) {
    assert.equal((await admin('POST', `/admin/orders/${order.id}/status`, { status })).status, 200);
  }
}
const askReturn = (call, order, refundTo) =>
  call('POST', `/orders/${order.id}/returns`, { items: [{ index: 0, qty: 1 }], reason: 'damaged', refundTo });

test('a return refunded as credit is refunded the moment it is approved', async () => {
  const call = await register();
  const order = (await place(call, BOOK)).body;
  await delivered(call, order);
  const ret = await askReturn(call, order, 'credit');
  assert.equal(ret.status, 201, JSON.stringify(ret.body));
  assert.deepEqual([ret.body.refund, ret.body.refundCredit, ret.body.refundMethod], [34900, 34900, 'credit']);
  const approved = await admin('POST', `/admin/returns/${ret.body.id}/approve`);
  assert.equal(approved.body.status, 'refunded');
  assert.equal(await balance(call), 34900);
  const [entry] = (await ledger(call)).items;
  assert.deepEqual([entry.reason, entry.change], ['returned', 34900]);
  const mail = t.mail.sent.findLast((m) => m.to.email === call.email);
  assert.match(mail.text, /₹349 is back in your account as store credit/);
  assert.doesNotMatch(mail.text, /refund of/);
});

test('money back never exceeds the money paid: the rest of a refund comes back as credit', async () => {
  const call = await customerWithCredit(30000);
  const p = await product(BOOK);
  const quote = await call('GET', `/cart?items=${p._id}:2`);
  // Two books (₹698, free delivery from ₹499), ₹300 of them with credit: ₹398 paid in cash.
  const res = await call('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty: 2 }],
    address,
    expectedTotal: quote.body.total,
    creditToUse: 30000,
  });
  assert.equal(res.body.total, 69800);
  const order = res.body;
  await delivered(call, order);
  const first = (await askReturn(call, order, 'money')).body;
  assert.deepEqual([first.refund, first.refundCredit, first.refundMethod], [34900, 0, 'manual']);
  const second = (await askReturn(call, order, 'money')).body;
  // Only ₹49 of cash is left to give back; ₹300 goes back as the credit it was.
  assert.deepEqual([second.refund, second.refundCredit, second.refundMethod], [34900, 30000, 'manual']);
  await admin('POST', `/admin/returns/${second.id}/approve`);
  assert.equal(await balance(call), 30000);
});

test("the customer's data download has their credit; closing the account removes its history", async () => {
  const call = await customerWithCredit(10000);
  const data = (await call('GET', '/account/data')).body;
  assert.equal(data.storeCredit.balance, 10000);
  assert.equal(data.storeCredit.history[0].reason, 'goodwill');
  const user = await t.db.collection('users').findOne({ email: call.email });
  const closed = await call('POST', '/account/close', { password: 'password123', confirm: true });
  assert.equal(closed.status, 204, JSON.stringify(closed.body));
  assert.equal(await t.db.collection('creditLedger').countDocuments({ userId: user._id }), 0);
});
