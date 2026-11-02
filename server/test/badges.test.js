import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { refreshBadges } from '../src/badges.js';

let t;
let admin;
let category;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'Store Admin');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  category = await t.db.collection('categories').findOne({ slug: 'books' });
});
after(() => t.stop());

let n = 0;
async function register(email = `buyer${++n}@example.com`, name = 'Asha Rao') {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
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
const product = (slug) => t.db.collection('products').findOne({ slug });
async function buy(call, slug, qty) {
  const p = await product(slug);
  const quote = await call('GET', `/cart?items=${p._id}:${qty}`);
  const res = await call('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty }],
    address,
    expectedTotal: quote.body.total,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
const badge = async (slug) => (await t.call('GET', `/products/${slug}`)).body.badge;
const newProduct = (title, active = true) =>
  admin('POST', '/admin/products', {
    title,
    brand: 'Kitwell',
    categoryId: category._id.toString(),
    price: 29900,
    mrp: 34900,
    stock: 50,
    active,
  });

test('the sample catalog has no badges before anything sells', async () => {
  await refreshBadges(t.db);
  const { items } = (await t.call('GET', '/products?pageSize=48')).body;
  assert.ok(items.length > 0);
  assert.ok(items.every((p) => p.badge === null));
});

test('a product is "new" for 30 days from when it is first shown', async () => {
  const shown = await newProduct('Kitwell Mug Shown');
  assert.equal(shown.status, 201, JSON.stringify(shown.body));
  assert.equal(await badge(shown.body.slug), 'new');
  // Cards in listings carry it too.
  const listed = (await t.call('GET', '/products?q=kitwell%20mug%20shown')).body.items;
  assert.equal(listed[0].badge, 'new');

  // Drafted hidden, then shown weeks later: new from then.
  const hidden = await newProduct('Kitwell Mug Draft', false);
  const doc = await product(hidden.body.slug);
  assert.equal(doc.firstShownAt, undefined);
  await t.db
    .collection('products')
    .updateOne({ _id: doc._id }, { $set: { createdAt: new Date(Date.now() - 60 * 864e5) } });
  assert.equal((await admin('PATCH', `/admin/products/${doc._id}`, { active: true })).status, 200);
  assert.equal(await badge(hidden.body.slug), 'new');

  // Hiding and showing again doesn't restart it.
  const first = (await product(hidden.body.slug)).firstShownAt;
  await admin('PATCH', `/admin/products/${doc._id}`, { active: false });
  await admin('PATCH', `/admin/products/${doc._id}`, { active: true });
  assert.deepEqual((await product(hidden.body.slug)).firstShownAt, first);

  // After 30 days it's no longer new.
  await t.db
    .collection('products')
    .updateOne({ _id: doc._id }, { $set: { firstShownAt: new Date(Date.now() - 31 * 864e5) } });
  assert.equal(await badge(hidden.body.slug), null);

  // Saving a sample product (already shown, no date) doesn't make it new.
  const book = await product('the-quiet-engineer-paperback');
  assert.equal((await admin('PATCH', `/admin/products/${book._id}`, { active: true })).status, 200);
  assert.equal(await badge('the-quiet-engineer-paperback'), null);
});

test('bestsellers: the top 3 per category by units sold in 30 days, from two customers or more', async () => {
  const asha = await register();
  const ravi = await register();
  // One customer's big basket isn't enough.
  await buy(asha, 'indian-history-in-100-objects', 5);
  await refreshBadges(t.db);
  assert.equal(await badge('indian-history-in-100-objects'), null);

  // Two customers, three units.
  await buy(ravi, 'indian-history-in-100-objects', 1);
  await refreshBadges(t.db);
  assert.equal(await badge('indian-history-in-100-objects'), 'bestseller');

  // A cancelled order doesn't count.
  const books = ['cooking-without-fuss', 'the-quiet-engineer-paperback', 'learning-to-code-with-javascript'];
  const cancelled = await buy(asha, books[1], 3);
  await buy(ravi, books[1], 1);
  await refreshBadges(t.db);
  assert.equal(await badge(books[1]), 'bestseller');
  assert.equal((await asha('POST', `/orders/${cancelled.id}/cancel`, {})).status, 200);
  await refreshBadges(t.db);
  assert.equal(await badge(books[1]), null);

  // Only three per category: the fourth best-selling book has none.
  for (const [slug, qty] of [
    ['the-quiet-engineer-paperback', 6],
    ['learning-to-code-with-javascript', 4],
    ['indian-history-in-100-objects', 2], // 8 in all now
  ]) {
    await buy(asha, slug, qty);
    await buy(ravi, slug, 1);
  }
  const kitwell = await newProduct('Kitwell Notebook');
  await buy(asha, kitwell.body.slug, 2);
  await buy(ravi, kitwell.body.slug, 1);
  await refreshBadges(t.db);
  assert.equal(await badge('indian-history-in-100-objects'), 'bestseller');
  assert.equal(await badge('the-quiet-engineer-paperback'), 'bestseller');
  assert.equal(await badge('learning-to-code-with-javascript'), 'bestseller');
  // 3 units to two customers, but fourth in its category: still new, so that's what it shows; once it isn't, none.
  assert.equal(await badge(kitwell.body.slug), 'new');
  await t.db
    .collection('products')
    .updateOne({ slug: kitwell.body.slug }, { $set: { firstShownAt: new Date(Date.now() - 31 * 864e5) } });
  assert.equal(await badge(kitwell.body.slug), null);

  // Older than 30 days: not counted.
  await t.db.collection('orders').updateMany({}, { $set: { createdAt: new Date(Date.now() - 31 * 864e5) } });
  await refreshBadges(t.db);
  assert.equal(await badge('indian-history-in-100-objects'), null);
});
