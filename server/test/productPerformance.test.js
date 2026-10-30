import { test, before, after, beforeEach } from 'node:test';
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
// Every test request comes from localhost, so they share one network's hourly limit.
beforeEach(() => t.db.collection('rateLimits').deleteMany({}));

async function register(email, name) {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name, email, password: 'password123' });
  assert.equal(res.status, 201);
  return call;
}

const BOOK = 'the-quiet-engineer-paperback';
const PHONE = 'orbit-a14-4gb-ram-64gb';
const product = (slug) => t.db.collection('products').findOne({ slug });
const seen = (call, slug, event) => call('POST', `/products/${slug}/seen`, { event });
const report = async (query = '') => (await admin('GET', `/admin/product-performance${query}`)).body;
const rowOf = (data, slug) => data.items.find((r) => r.slug === slug);

test('the product page reports views and adds to cart; staff, unknown products and bad events don’t count', async () => {
  assert.equal((await seen(t.call, BOOK, 'view')).status, 204);
  assert.equal((await seen(customer, BOOK, 'view')).status, 204);
  assert.equal((await seen(customer, BOOK, 'cart')).status, 204);
  assert.equal((await seen(admin, BOOK, 'view')).status, 204); // staff: not counted
  assert.equal((await seen(t.call, 'no-such-book', 'view')).status, 404);
  assert.equal((await seen(t.call, BOOK, 'buy')).status, 400);

  const [doc] = await t.db
    .collection('productStats')
    .find({ productId: (await product(BOOK))._id })
    .toArray();
  assert.equal(doc.views, 2);
  assert.equal(doc.carts, 1);
  assert.match(doc.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(doc.expiresAt > new Date(Date.now() + 90 * 86_400_000));
  // Nothing about the visitor.
  assert.deepEqual(Object.keys(doc).sort(), ['_id', 'carts', 'day', 'expiresAt', 'productId', 'views']);
});

test('one network’s reports are limited per hour, quietly', async () => {
  await seen(t.call, PHONE, 'view');
  const limit = await t.db.collection('rateLimits').findOne({ _id: /^productSeen:/ });
  const uses = Array.from({ length: 300 }, (_, i) => ({ at: new Date(), id: String(i) }));
  await t.db.collection('rateLimits').updateOne({ _id: limit._id }, { $set: { uses } });
  assert.equal((await seen(t.call, PHONE, 'view')).status, 204);
  const doc = await t.db.collection('productStats').findOne({ productId: (await product(PHONE))._id });
  assert.equal(doc.views, 1);
});

test('admins see views, carts and orders per product, sorted and filtered', async () => {
  assert.equal((await customer('GET', '/admin/product-performance')).status, 403);
  assert.equal((await admin('GET', '/admin/product-performance?days=14')).status, 400);

  // The book is bought once (two copies); the phone is looked at a lot and never bought.
  const book = await product(BOOK);
  const quote = await customer('GET', `/cart?items=${book._id}:2`);
  const order = await customer('POST', '/orders', {
    items: [{ productId: book._id.toString(), qty: 2 }],
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
  const phone = await product(PHONE);
  const today = (await t.db.collection('productStats').findOne({ productId: phone._id })).day;
  await t.db.collection('productStats').updateOne({ productId: phone._id, day: today }, { $set: { views: 40 } });
  // Older than a week: only in the 30-day figures.
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  await t.db
    .collection('productStats')
    .insertOne({ productId: book._id, day: old, views: 50, carts: 5, expiresAt: new Date(Date.now() + 86_400_000) });

  const month = await report();
  assert.equal(month.days, 30);
  assert.deepEqual(
    month.items.slice(0, 2).map((r) => r.slug),
    [BOOK, PHONE],
  ); // most viewed first: 52 and 40
  const bookRow = rowOf(month, BOOK);
  assert.deepEqual(
    [bookRow.views, bookRow.carts, bookRow.orders, bookRow.units, bookRow.conversion],
    [52, 6, 1, 2, 1.9],
  );
  const phoneRow = rowOf(month, PHONE);
  assert.equal(phoneRow.orders, 0);
  assert.equal(phoneRow.conversion, 0);
  assert.equal(phoneRow.notBought, true);
  assert.equal(bookRow.notBought, false);

  const week = await report('?days=7');
  assert.equal(rowOf(week, BOOK).views, 2);
  assert.equal(rowOf(week, BOOK).conversion, 50);

  assert.deepEqual((await report('?days=7&sort=conversion')).items[0].slug, BOOK);
  assert.deepEqual((await report('?days=7&sort=orders')).items[0].slug, BOOK);
  const notBought = await report('?notBought=1');
  assert.deepEqual(
    notBought.items.map((r) => r.slug),
    [PHONE],
  );
  assert.equal(notBought.notBoughtViews, 10);
});
