import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cashbackOn, payCashback } from '../src/cashback.js';
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

const DAY = 86_400_000;
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
const orders = () => t.db.collection('orders');
const credit = async () => (await customer('GET', '/auth/me')).body.user.credit;

// A delivered order, delivered `daysAgo` days ago.
async function delivered(slug, daysAgo) {
  const p = await t.db.collection('products').findOne({ slug });
  const quote = await customer('GET', `/cart?items=${p._id}:1`);
  const placed = (
    await customer('POST', '/orders', {
      items: [{ productId: p._id.toString(), qty: 1 }],
      address,
      expectedTotal: quote.body.total,
    })
  ).body;
  for (const status of ['shipped', 'delivered']) {
    assert.equal((await admin('POST', `/admin/orders/${placed.id}/status`, { status })).status, 200);
  }
  await orders().updateOne({ number: placed.number }, { $set: { deliveredAt: new Date(Date.now() - daysAgo * DAY) } });
  return placed;
}
const cashbackOf = async (order) => (await orders().findOne({ number: order.number })).cashback ?? null;

test('the percentage, down to whole rupees, at most the cap', () => {
  assert.equal(cashbackOn(34900, { percent: 5, cap: 10000 }), 1700); // ₹17.45 → ₹17
  assert.equal(cashbackOn(899900, { percent: 5, cap: 10000 }), 10000); // ₹449 → the ₹100 cap
  assert.equal(cashbackOn(-500, { percent: 5, cap: 10000 }), 0);
});

test('off until switched on, and never for orders placed before', async () => {
  const before = await delivered(BOOK, 10);
  assert.equal(await payCashback(t.ctx), 0);
  const p = await t.db.collection('products').findOne({ slug: BOOK });
  assert.equal((await customer('GET', `/cart?items=${p._id}:1`)).body.cashback, null);

  const on = await admin('PUT', '/admin/cashback', { enabled: true, percent: 5, cap: 10000 });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.ok(on.body.since);
  assert.deepEqual((await customer('GET', `/cart?items=${p._id}:1`)).body.cashback, { amount: 1700, percent: 5 });
  assert.equal(await payCashback(t.ctx), 0);
  assert.equal(await cashbackOf(before), null);
  const log = await t.db.collection('activity').findOne({ action: 'Changed cashback' });
  assert.deepEqual(log.changes[0], { field: 'On', from: 'no', to: 'yes' });
});

test('paid once the return window has passed, once, with an email and a credit entry', async () => {
  const recent = await delivered(BOOK, 3);
  const old = await delivered(BOOK, 8);
  const balance = await credit();
  // Two sweeps at the same moment pay it once.
  const [a, b] = await Promise.all([payCashback(t.ctx), payCashback(t.ctx)]);
  assert.equal(a + b, 1);
  assert.equal((await cashbackOf(old)).amount, 1700);
  assert.equal(await cashbackOf(recent), null); // still within its 7 days
  assert.equal(await credit(), balance + 1700);
  const [entry] = (await customer('GET', '/account/credit')).body.items;
  assert.deepEqual([entry.reason, entry.change, entry.order.number], ['cashback', 1700, old.number]);
  const mail = t.mail.sent.findLast((m) => m.to.email === 'customer@example.com');
  assert.equal(mail.subject, `₹17 cashback for order #${old.number}`);
  assert.equal(await payCashback(t.ctx), 0);
});

test('capped per order; a return awaiting a decision waits; refunded items earn nothing', async () => {
  const phone = await delivered(PHONE, 8);
  const book = await delivered(BOOK, 2);
  // A return asked for within the window, then the window passes.
  const ret = await customer('POST', `/orders/${book.id}/returns`, {
    items: [{ index: 0, qty: 1 }],
    reason: 'damaged',
  });
  assert.equal(ret.status, 201, JSON.stringify(ret.body));
  await orders().updateOne({ number: book.number }, { $set: { deliveredAt: new Date(Date.now() - 8 * DAY) } });

  await payCashback(t.ctx);
  assert.equal((await cashbackOf(phone)).amount, 10000);
  assert.equal(await cashbackOf(book), null); // waiting for the return's decision
  await admin('POST', `/admin/returns/${ret.body.id}/approve`);
  await payCashback(t.ctx);
  assert.equal((await cashbackOf(book)).amount, 0); // everything came back
});

test('settings are checked and admins only; the page reports what was paid', async () => {
  for (const [body, error] of [
    [{ enabled: true, percent: 0, cap: 10000 }, 'From 1%'],
    [{ enabled: true, percent: 30, cap: 10000 }, 'At most 20%'],
    [{ enabled: true, percent: 2, cap: 10050 }, 'Whole rupees'],
  ]) {
    const res = await admin('PUT', '/admin/cashback', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.error.includes(error), `${res.body.error} / ${error}`);
  }
  const page = (await admin('GET', '/admin/cashback')).body;
  assert.deepEqual(page.paid, { total: 11700, orders: 2 });
  assert.equal((await customer('GET', '/admin/cashback')).status, 403);
  // Switching off and on again starts the clock afresh.
  const since = page.since;
  await admin('PUT', '/admin/cashback', { enabled: false, percent: 5, cap: 10000 });
  const again = await admin('PUT', '/admin/cashback', { enabled: true, percent: 5, cap: 10000 });
  assert.ok(new Date(again.body.since) > new Date(since));
});
