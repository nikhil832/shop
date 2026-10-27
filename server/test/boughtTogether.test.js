import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { BOUGHT_TOGETHER } from '../src/routes/catalog.js';
import { startTestServer } from './helpers.js';

let t;
let ids;
before(async () => {
  t = await startTestServer();
  const docs = await t.db
    .collection('products')
    .find({}, { projection: { slug: 1 } })
    .toArray();
  ids = Object.fromEntries(docs.map((d) => [d.slug, d._id]));
});
after(() => t.stop());

const MIXER = 'rasoi-mixer-grinder-750w';
const BOOK = 'the-quiet-engineer-paperback';
const PHONE = 'orbit-a14-4gb-ram-64gb';
const JEANS = 'urbane-men-slim-fit-jeans';
const SOLD_OUT = 'aura-electric-kettle-1-5l';

const alsoBought = async (slug = MIXER) => {
  const res = await t.call('GET', `/products/${slug}/bought-together`);
  assert.equal(res.status, 200);
  return res.body.items.map((p) => p.slug);
};
// An order of these products by `userId` (raw, as only the items, customer and status matter here).
const order = (userId, slugs, status = 'placed') => ({
  userId,
  status,
  createdAt: new Date(),
  items: slugs.map((slug) => ({ productId: ids[slug], qty: 1 })),
});
const customers = Array.from({ length: 5 }, () => new ObjectId());

test('nothing until two different customers bought something with it', async () => {
  assert.deepEqual(await alsoBought(), []);
  const orders = t.db.collection('orders');
  // One customer, twice: still only their own basket.
  await orders.insertMany([order(customers[0], [MIXER, BOOK]), order(customers[0], [MIXER, BOOK], 'delivered')]);
  assert.deepEqual(await alsoBought(), []);
  await orders.insertOne(order(customers[1], [MIXER, BOOK], 'shipped'));
  assert.deepEqual(await alsoBought(), [BOOK]);
  // It works both ways.
  assert.deepEqual(await alsoBought(BOOK), [MIXER]);
});

test('ranked by customers, then orders; cancelled and unpaid orders and the product itself are left out', async () => {
  const orders = t.db.collection('orders');
  await orders.insertMany([
    // The phone: three customers.
    order(customers[2], [MIXER, PHONE]),
    order(customers[3], [MIXER, PHONE]),
    order(customers[4], [MIXER, PHONE]),
    // The jeans: two customers, but only in orders that aren't sales.
    order(customers[2], [MIXER, JEANS], 'cancelled'),
    order(customers[3], [MIXER, JEANS], 'awaiting_payment'),
    // Two sizes of the jeans in one order with the kettle: one order, and still one customer.
    order(customers[4], [MIXER, JEANS, JEANS]),
  ]);
  assert.deepEqual(await alsoBought(), [PHONE, BOOK]);
});

test('hidden or sold-out products are left out, and only real products are asked about', async () => {
  const products = t.db.collection('products');
  const orders = t.db.collection('orders');
  await orders.insertMany([order(customers[0], [MIXER, SOLD_OUT]), order(customers[1], [MIXER, SOLD_OUT])]);
  assert.ok(!(await alsoBought()).includes(SOLD_OUT));
  await products.updateOne({ slug: PHONE }, { $set: { active: false } });
  assert.deepEqual(await alsoBought(), [BOOK]);
  await products.updateOne({ slug: PHONE }, { $set: { active: true } });
  await products.updateOne({ slug: MIXER }, { $set: { active: false } });
  assert.equal((await t.call('GET', `/products/${MIXER}/bought-together`)).status, 404);
  await products.updateOne({ slug: MIXER }, { $set: { active: true } });
  assert.equal((await t.call('GET', '/products/no-such-product/bought-together')).status, 404);
});

test(`at most ${BOUGHT_TOGETHER} products, as product cards`, async () => {
  const others = Object.keys(ids)
    .filter((s) => ![MIXER, SOLD_OUT].includes(s))
    .slice(0, BOUGHT_TOGETHER + 3);
  await t.db
    .collection('orders')
    .insertMany([order(customers[0], [MIXER, ...others]), order(customers[1], [MIXER, ...others])]);
  const res = await t.call('GET', `/products/${MIXER}/bought-together`);
  assert.equal(res.body.items.length, BOUGHT_TOGETHER);
  assert.deepEqual(Object.keys(res.body.items[0]), Object.keys((await t.call('GET', '/products')).body.items[0]));
});
