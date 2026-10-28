import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'Store Admin');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  customer = await register('customer@example.com', 'Asha Rao');
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name, email, password: 'password123' });
  assert.equal(res.status, 201);
  return call;
}

const DAY = 86_400_000;
const product = (slug) => t.db.collection('products').findOne({ slug });
// Today's date in India time, as the dashboard counts days.
const istDay = (time) => new Date(time + 330 * 60_000).toISOString().slice(0, 10);

// An order stored directly, `daysAgo` days before now, so dates and amounts are exact.
async function addOrder({ daysAgo = 0, status = 'placed', items, discount = 0 }) {
  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const createdAt = new Date(Date.now() - daysAgo * DAY);
  await t.db.collection('orders').insertOne({
    userId: new ObjectId(),
    items,
    subtotal,
    delivery: 0,
    discount,
    total: subtotal - discount,
    status,
    payment: { method: 'cod' },
    createdAt,
    updatedAt: createdAt,
  });
}
const line = (p, qty) => ({ productId: p._id, title: p.title, price: p.price, qty, image: p.images[0] });

test('the dashboard needs an admin: 401 logged out, 403 for customers', async () => {
  assert.equal((await t.call('GET', '/admin/dashboard')).status, 401);
  assert.equal((await customer('GET', '/admin/dashboard')).status, 403);
});

test('validates the period', async () => {
  for (const days of ['1', '31', 'abc', '']) {
    const res = await admin('GET', `/admin/dashboard?days=${days}`);
    assert.equal(res.status, 400, days);
  }
});

test('with no orders: zeros for every day, and the low-stock list', async () => {
  const res = await admin('GET', '/admin/dashboard');
  assert.equal(res.status, 200);
  assert.equal(res.body.days, 30);
  assert.equal(res.body.daily.length, 30);
  assert.equal(res.body.daily.at(-1).date, istDay(Date.now()));
  assert.ok(res.body.daily.every((d) => d.revenue === 0 && d.orders === 0));
  assert.deepEqual(res.body.totals, {
    revenue: 0,
    orders: 0,
    averageOrder: 0,
    itemsSold: 0,
    discount: 0,
    cancelled: 0,
    refunds: 0,
    itemsReturned: 0,
    netRevenue: 0,
  });
  assert.deepEqual(res.body.bestSellers, []);
  assert.equal(res.body.toShip, 0);

  // Active products with 5 or fewer left (or a variant with that few), fewest first; hidden ones are left out.
  const low = await t.db
    .collection('products')
    .find({ active: true, $or: [{ stock: { $lte: 5 } }, { 'variants.stock': { $lte: 5 } }] })
    .toArray();
  assert.equal(res.body.lowStockCount, low.length);
  assert.ok(res.body.lowStock.length > 0 && res.body.lowStock.length <= 10);
  // Sorted by the lowest stock of the product or any of its variants.
  const lowest = res.body.lowStock.map((p) => Math.min(p.stock, ...p.variants.map((v) => v.stock)));
  assert.deepEqual(
    lowest,
    [...lowest].sort((a, b) => a - b),
  );
  // The sample shoes are listed by their low size only.
  const shoes = res.body.lowStock.find((p) => p.slug === 'stride-running-shoes');
  assert.deepEqual(shoes?.variants, [{ label: 'UK 10', stock: 5 }]);
  const hidden = res.body.lowStock[0];
  await t.db.collection('products').updateOne({ slug: hidden.slug }, { $set: { active: false } });
  const after = (await admin('GET', '/admin/dashboard')).body;
  assert.equal(after.lowStockCount, low.length - 1);
  assert.ok(!after.lowStock.some((p) => p.slug === hidden.slug));
  await t.db.collection('products').updateOne({ slug: hidden.slug }, { $set: { active: true } });
});

test('counts sales by day, compares with the period before, and ranks best sellers', async () => {
  const book = await product('learning-to-code-with-javascript');
  const other = (
    await t.db
      .collection('products')
      .find({ stock: { $gt: 10 } })
      .limit(2)
      .toArray()
  ).find((p) => !p._id.equals(book._id));

  await addOrder({ items: [line(book, 2)] }); // today
  await addOrder({ daysAgo: 3, status: 'delivered', items: [line(book, 1), line(other, 1)], discount: 5000 });
  await addOrder({ daysAgo: 6, status: 'shipped', items: [line(other, 3)] });
  // Not sales: cancelled, unpaid, or outside the 7 days.
  await addOrder({ daysAgo: 1, status: 'cancelled', items: [line(other, 5)] });
  await addOrder({ status: 'awaiting_payment', items: [line(other, 5)] });
  await addOrder({ daysAgo: 8, items: [line(book, 4)] });

  const res = await admin('GET', '/admin/dashboard?days=7');
  assert.equal(res.status, 200);
  const { totals, previous, daily, bestSellers, toShip } = res.body;

  const revenue = book.price * 3 + other.price * 4 - 5000;
  assert.deepEqual(totals, {
    revenue,
    orders: 3,
    averageOrder: Math.round(revenue / 3),
    itemsSold: 7,
    discount: 5000,
    cancelled: 1,
    refunds: 0,
    itemsReturned: 0,
    netRevenue: revenue,
  });
  // The 8-days-ago order is in the 7 days before.
  assert.deepEqual(previous, { revenue: book.price * 4, orders: 1, refunds: 0, netRevenue: book.price * 4, profit: 0 }); // no cost prices yet

  assert.equal(daily.length, 7);
  const day = (daysAgo) => daily.find((d) => d.date === istDay(Date.now() - daysAgo * DAY));
  assert.deepEqual(day(0), { date: istDay(Date.now()), revenue: book.price * 2, orders: 1, refunds: 0 });
  assert.equal(day(3).revenue, book.price + other.price - 5000);
  assert.equal(day(1).orders, 0);
  assert.equal(
    daily.reduce((sum, d) => sum + d.revenue, 0),
    revenue,
  );

  // Ranked by quantity sold; sales are item prices before discounts.
  assert.deepEqual(
    bestSellers.map((b) => [b.slug, b.qty, b.sales]),
    [
      [other.slug, 4, other.price * 4],
      [book.slug, 3, book.price * 3],
    ],
  );
  assert.equal(bestSellers[0].title, other.title);
  // Placed orders of any date are waiting to be shipped.
  assert.equal(toShip, 2);

  // The 30-day view takes in the older order too.
  const month = (await admin('GET', '/admin/dashboard?days=30')).body;
  assert.equal(month.totals.orders, 4);
  assert.equal(month.daily.length, 30);
});

test('an order placed through checkout shows up today', async () => {
  const before = (await admin('GET', '/admin/dashboard?days=7')).body;
  const p = await product('learning-to-code-with-javascript');
  const quote = await customer('GET', `/cart?items=${p._id}:1`);
  const order = await customer('POST', '/orders', {
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
  assert.equal(order.status, 201);
  const res = (await admin('GET', '/admin/dashboard?days=7')).body;
  assert.equal(res.totals.orders, before.totals.orders + 1);
  assert.equal(res.totals.revenue, before.totals.revenue + order.body.total);
  assert.equal(res.daily.at(-1).revenue, before.daily.at(-1).revenue + order.body.total);
  assert.equal(res.toShip, before.toShip + 1);
});

test("approved returns count against their order's days: net revenue, refunds per day, best sellers net of returns", async () => {
  // Compared with the figures just before, so the orders of the tests above don't matter.
  const before = (await admin('GET', '/admin/dashboard?days=7')).body;
  const book = await product('learning-to-code-with-javascript');
  await addOrder({ daysAgo: 2, status: 'delivered', items: [line(book, 3)] });
  const order = await t.db.collection('orders').findOne({}, { sort: { createdAt: -1 } });
  const ret = (status, qty, refund) => ({
    orderId: order._id,
    userId: order.userId,
    items: [{ index: 0, productId: book._id, title: book.title, price: book.price, qty }],
    reason: 'damaged',
    note: '',
    refund,
    refundMethod: 'manual',
    status,
    createdAt: new Date(),
  });
  // One refunded and one approved count; requested and declined ones don't.
  await t.db
    .collection('returns')
    .insertMany([
      ret('refunded', 1, book.price),
      ret('approved', 1, book.price),
      ret('requested', 1, book.price),
      ret('declined', 1, book.price),
    ]);

  const after = (await admin('GET', '/admin/dashboard?days=7')).body;
  assert.equal(after.totals.revenue, before.totals.revenue + book.price * 3);
  assert.equal(after.totals.refunds, before.totals.refunds + book.price * 2);
  assert.equal(after.totals.itemsReturned, before.totals.itemsReturned + 2);
  assert.equal(after.totals.netRevenue, after.totals.revenue - after.totals.refunds);
  const day = after.daily.find((d) => d.date === istDay(order.createdAt.getTime()));
  assert.equal(day.refunds, book.price * 2);
  const seller = after.bestSellers.find((b) => b.slug === book.slug);
  const sellerBefore = before.bestSellers.find((b) => b.slug === book.slug);
  assert.equal(seller.qty, (sellerBefore?.qty ?? 0) + 1); // 3 sold, 2 back
  assert.equal(seller.returned, 2);
  assert.equal(seller.sales, (sellerBefore?.sales ?? 0) + book.price);
  await t.db.collection('returns').deleteMany({ orderId: order._id });
});

test('admins switch the morning low-stock email off and on; customers and visitors cannot', async () => {
  assert.equal((await admin('GET', '/admin/dashboard')).body.lowStockEmail, true);

  assert.equal((await t.call('PUT', '/admin/dashboard/low-stock-email', { enabled: false })).status, 401);
  assert.equal((await customer('PUT', '/admin/dashboard/low-stock-email', { enabled: false })).status, 403);
  const bad = await admin('PUT', '/admin/dashboard/low-stock-email', { enabled: 'no' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /true or false/);

  const off = await admin('PUT', '/admin/dashboard/low-stock-email', { enabled: false });
  assert.deepEqual([off.status, off.body], [200, { enabled: false }]);
  assert.equal((await admin('GET', '/admin/dashboard')).body.lowStockEmail, false);
  await admin('PUT', '/admin/dashboard/low-stock-email', { enabled: true });
  assert.equal((await admin('GET', '/admin/dashboard')).body.lowStockEmail, true);
});
