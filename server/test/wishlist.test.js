import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
before(async () => {
  t = await startTestServer();
});
after(() => t.stop());

let n = 0;
async function register() {
  const call = t.browser();
  const res = await call('POST', '/auth/register', {
    name: 'Asha Rao',
    email: `wisher${++n}@example.com`,
    password: 'password123',
  });
  assert.equal(res.status, 201);
  return call;
}
const productId = async (slug) => (await t.db.collection('products').findOne({ slug }))._id.toString();

test('the wishlist needs an account', async () => {
  const id = await productId('the-quiet-engineer-paperback');
  assert.equal((await t.call('GET', '/wishlist')).status, 401);
  assert.equal((await t.call('PUT', `/wishlist/${id}`)).status, 401);
  assert.equal((await t.call('DELETE', `/wishlist/${id}`)).status, 401);
  // Logged out, products are never marked as saved.
  assert.equal((await t.call('GET', '/products/the-quiet-engineer-paperback')).body.wishlisted, false);
});

test('saving, listing and removing products', async () => {
  const call = await register();
  const book = await productId('the-quiet-engineer-paperback');
  const shirt = await productId('urbane-men-cotton-polo-t-shirt');

  assert.deepEqual((await call('PUT', `/wishlist/${book}`)).body, { saved: true });
  // Saving twice keeps one entry.
  assert.equal((await call('PUT', `/wishlist/${book}`)).status, 200);
  await call('PUT', `/wishlist/${shirt}`);

  let res = await call('GET', '/wishlist');
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.map((p) => p.slug),
    ['urbane-men-cotton-polo-t-shirt', 'the-quiet-engineer-paperback'],
  );
  assert.equal(res.body[0].price, 59900);
  assert.equal((await call('GET', '/products/the-quiet-engineer-paperback')).body.wishlisted, true);

  // Each account has its own list.
  const other = await register();
  assert.deepEqual((await other('GET', '/wishlist')).body, []);
  assert.equal((await other('GET', '/products/the-quiet-engineer-paperback')).body.wishlisted, false);

  assert.deepEqual((await call('DELETE', `/wishlist/${book}`)).body, { saved: false });
  assert.equal((await call('DELETE', `/wishlist/${book}`)).status, 200);
  res = await call('GET', '/wishlist');
  assert.deepEqual(
    res.body.map((p) => p.slug),
    ['urbane-men-cotton-polo-t-shirt'],
  );
});

test('hidden products drop out of the wishlist until shown again', async () => {
  const call = await register();
  const id = await productId('monsoon-stories-hardcover');
  await call('PUT', `/wishlist/${id}`);
  const products = t.db.collection('products');
  await products.updateOne({ slug: 'monsoon-stories-hardcover' }, { $set: { active: false } });
  assert.deepEqual((await call('GET', '/wishlist')).body, []);
  // A hidden product can't be added either.
  assert.equal((await call('PUT', `/wishlist/${id}`)).status, 404);
  await products.updateOne({ slug: 'monsoon-stories-hardcover' }, { $set: { active: true } });
  assert.equal((await call('GET', '/wishlist')).body.length, 1);
});

test('unknown or malformed product ids are refused', async () => {
  const call = await register();
  assert.equal((await call('PUT', `/wishlist/${'0'.repeat(24)}`)).status, 404);
  assert.equal((await call('PUT', '/wishlist/not-an-id')).status, 400);
  assert.equal((await call('DELETE', '/wishlist/not-an-id')).status, 400);
});

test('a wishlist holds at most 200 products', async () => {
  const call = await register();
  const user = await t.db.collection('users').findOne({ email: `wisher${n}@example.com` });
  const products = await t.db.collection('products').find().limit(2).toArray();
  // Fill it directly with 200 entries (products may repeat here; only the count matters).
  await t.db.collection('wishlist').insertMany(
    Array.from({ length: 200 }, (_, i) => ({
      userId: user._id,
      productId: i === 0 ? products[0]._id : new products[0]._id.constructor(),
      addedAt: new Date(),
    })),
  );
  const res = await call('PUT', `/wishlist/${products[1]._id}`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'Your wishlist is full (200 items). Remove something first');
  // Saving one that's already there still works.
  assert.equal((await call('PUT', `/wishlist/${products[0]._id}`)).status, 200);
});
