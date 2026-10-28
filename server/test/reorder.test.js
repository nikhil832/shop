import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { daysLeft, runningOut, suggestion } from '../src/reorder.js';
import { sendLowStockEmail } from '../src/lowStockEmail.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
let category;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  customer = await register('customer@example.com', 'Asha Rao');
  category = (await t.db.collection('categories').findOne({ slug: 'home-kitchen' }))._id.toString();
  t.ctx.config.mail.adminEmails = ['owner@example.com'];
});
after(() => t.stop());
// Only this file's own products and orders count.
beforeEach(() => t.db.collection('orders').deleteMany({}));

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}

const DAY = 86_400_000;
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
let n = 0;
// A product with `stock`, added `ageDays` ago (optionally with sizes).
async function product({ stock = 20, ageDays = 60, variants } = {}) {
  const res = await admin('POST', '/admin/products', {
    title: `Steel Tiffin ${++n}`,
    brand: 'Griha',
    categoryId: category,
    ...(variants
      ? { variantName: 'Size', variants: variants.map(([label, s]) => ({ label, price: 49900, mrp: 59900, stock: s })) }
      : { price: 49900, mrp: 59900, stock }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  await t.db
    .collection('products')
    .updateOne({ slug: res.body.slug }, { $set: { createdAt: new Date(Date.now() - ageDays * DAY) } });
  return res.body;
}
// An order of `qty` (more than 10 of one item is several orders, as the store allows 10 per line).
async function buy(p, qty, variantId) {
  if (qty > 10) {
    await buy(p, 10, variantId);
    return buy(p, qty - 10, variantId);
  }
  const key = `${p.id}${variantId ? `.${variantId}` : ''}`;
  const quote = await customer('GET', `/cart?items=${key}:${qty}`);
  const res = await customer('POST', '/orders', {
    items: [{ productId: p.id, ...(variantId && { variantId }), qty }],
    address,
    expectedTotal: quote.body.total,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
const find = (list, p, variantId = null) =>
  list.items.find((r) => r.productId === p.id && r.variantId === variantId) ?? null;

test('days left and the suggestion: stock over the daily rate, and enough for a month', () => {
  assert.equal(daysLeft(5, 0.5), 10);
  assert.equal(daysLeft(0, 2), 0);
  assert.equal(suggestion(5, 0.5), 10); // 15 a month, 5 in stock
  assert.equal(suggestion(40, 0.5), 0);
});

test('a product selling fast is listed with its days left and how many to order', async () => {
  const fast = await product({ stock: 20 });
  const slow = await product({ stock: 20 });
  await buy(fast, 10);
  await buy(fast, 5); // 15 in 30 days: 0.5 a day, 5 left → 10 days
  await buy(slow, 2); // 2 in 30 days, 18 left → 270 days: not listed
  const list = await runningOut(t.db);
  const row = find(list, fast);
  assert.deepEqual([row.stock, row.sold, row.days, row.perDay, row.daysLeft, row.suggest], [5, 15, 30, 0.5, 10, 10]);
  assert.equal(find(list, slow), null);
});

test('a new product is judged on the days since it was added, at least a week', async () => {
  const fresh = await product({ stock: 10, ageDays: 0 });
  await buy(fresh, 5); // 5 in 7 days (not 30): 0.7 a day, 5 left → 7 days
  const row = find(await runningOut(t.db), fresh);
  assert.deepEqual([row.days, row.daysLeft], [7, 7]);
});

test('cancelled orders, hidden products and removed options don’t count; options are listed one by one', async () => {
  // Counted, either would have 2 left at 10 a month: 6 days.
  const cancelledOnly = await product({ stock: 12 });
  const order = await buy(cancelledOnly, 10);
  await customer('POST', `/orders/${order.id}/cancel`);
  const hidden = await product({ stock: 12 });
  await buy(hidden, 10);
  await admin('PATCH', `/admin/products/${hidden.id}`, { active: false });
  const sized = await product({
    variants: [
      ['S', 10],
      ['M', 10],
    ],
  });
  const [s, m] = sized.variants;
  await buy(sized, 8, s.id); // S: 2 left at 8 a month → 7 days
  await buy(sized, 1, m.id); // M: 9 left → 270 days

  const list = await runningOut(t.db);
  assert.equal(find(list, cancelledOnly), null);
  assert.equal(find(list, hidden), null);
  const row = find(list, sized, s.id);
  assert.deepEqual([row.label, row.stock, row.daysLeft], ['S', 2, 7]);
  assert.equal(find(list, sized, m.id), null);
  // Soonest first.
  assert.deepEqual(
    list.items.map((r) => r.daysLeft),
    [...list.items.map((r) => r.daysLeft)].sort((a, b) => a - b),
  );
});

test('the dashboard lists them; the morning email does too, even when nothing is low', async () => {
  const p = await product({ stock: 30 });
  await buy(p, 20); // 10 left at 20 a month → 15 days: not yet
  assert.equal(find((await admin('GET', '/admin/dashboard')).body.runningOut, p), null);
  await buy(p, 4); // 6 left at 24 a month → 7 days
  const dashboard = (await admin('GET', '/admin/dashboard')).body;
  assert.equal(find(dashboard.runningOut, p).daysLeft, 7);
  assert.ok(dashboard.runningOut.total >= 1);

  // Nothing at 5 or fewer in this product; the email still goes, naming it.
  await t.db.collection('settings').deleteOne({ _id: 'lowStockEmail' });
  t.mail.sent.length = 0;
  const nineAm = new Date(Date.now() + DAY);
  nineAm.setUTCHours(3, 30, 0, 0); // 9:00 India time
  assert.equal(await sendLowStockEmail(t.ctx, nineAm), 'sent');
  const mail = t.mail.sent.find((m) => m.to.email === 'owner@example.com');
  assert.match(mail.text, /Running out within two weeks/);
  assert.match(
    mail.text,
    new RegExp(`${p.title}: \\d+ days \\(6 left, sells about 0\\.8 a day; order about \\d+ for a month\\)`),
  );
});

test('only admins see the dashboard', async () => {
  assert.equal((await customer('GET', '/admin/dashboard')).status, 403);
});
