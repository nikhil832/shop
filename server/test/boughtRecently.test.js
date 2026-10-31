import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { startTestServer } from './helpers.js';

let t;
before(async () => {
  t = await startTestServer();
});
after(() => t.stop());

const DAY = 86_400_000;
async function addOrder(product, userId, { daysAgo = 1, status = 'placed' } = {}) {
  const createdAt = new Date(Date.now() - daysAgo * DAY);
  await t.db.collection('orders').insertOne({
    userId,
    items: [{ productId: product._id, title: product.title, price: product.price, qty: 1 }],
    total: product.price,
    status,
    createdAt,
    updatedAt: createdAt,
  });
}
const people = (n) => Array.from({ length: n }, () => new ObjectId());

test('the product page says how many people bought it this week, from five', async () => {
  const book = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const read = async () => (await t.call('GET', `/products/${book.slug}`)).body.boughtRecently;
  assert.equal(await read(), null);

  const buyers = people(4);
  for (const userId of buyers) await addOrder(book, userId);
  // One person's second order, and orders that don't count: older than a week, cancelled, unpaid.
  await addOrder(book, buyers[0], { daysAgo: 2 });
  await addOrder(book, new ObjectId(), { daysAgo: 8 });
  await addOrder(book, new ObjectId(), { status: 'cancelled' });
  await addOrder(book, new ObjectId(), { status: 'awaiting_payment' });
  assert.equal(await read(), null); // four people

  await addOrder(book, new ObjectId(), { status: 'delivered', daysAgo: 6 });
  assert.deepEqual(await read(), { people: 5, days: 7 });

  // Another product's page isn't affected.
  const other = (await t.call('GET', '/products/learning-to-code-with-javascript')).body;
  assert.equal(other.boughtRecently, null);
});
