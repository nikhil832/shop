import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
let main;
let a;
let b;
let c;
let soldOut;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  customer = await register('customer@example.com', 'Asha Rao');
  const products = t.db.collection('products');
  [main, a, b, c] = await products
    .find({ stock: { $gte: 10 }, active: true })
    .sort({ title: 1 })
    .limit(4)
    .toArray();
  soldOut = await products.findOne({ stock: 0 });
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}

const ids = (...docs) => docs.map((d) => d._id.toString());
const setAddOns = (product, addOns) => admin('PATCH', `/admin/products/${product._id}`, { addOns });

test('an admin picks add-ons; the product page shows those that can be bought, in that order', async () => {
  const res = await setAddOns(main, ids(b, soldOut, a));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.addOns, ids(b, soldOut, a));
  assert.deepEqual(
    res.body.addOnProducts.map((p) => p.title),
    [b.title, soldOut.title, a.title],
  );
  assert.deepEqual((await admin('GET', `/admin/products/${main._id}`)).body.addOnProducts.length, 3);

  const page = (await t.call('GET', `/products/${main.slug}`)).body;
  assert.deepEqual(
    page.addOns.map((p) => p.slug),
    [b.slug, a.slug],
  );
  assert.equal(page.addOns[0].price, b.price);

  // Hidden ones drop out until shown again.
  await t.db.collection('products').updateOne({ _id: b._id }, { $set: { active: false } });
  assert.deepEqual(
    (await t.call('GET', `/products/${main.slug}`)).body.addOns.map((p) => p.slug),
    [a.slug],
  );
  await t.db.collection('products').updateOne({ _id: b._id }, { $set: { active: true } });

  const entry = await t.db.collection('activity').findOne({ 'changes.field': 'Goes well with' });
  assert.deepEqual(
    entry.changes.find((ch) => ch.field === 'Goes well with'),
    { field: 'Goes well with', from: '0', to: '3 (changed)' },
  );
});

test('add-ons are checked', async () => {
  const self = await setAddOns(main, ids(main));
  assert.equal(self.status, 400);
  assert.match(self.body.error, /itself/);
  assert.equal((await setAddOns(main, ids(a, a))).status, 400);
  assert.equal((await setAddOns(main, [...ids(a), '0123456789abcdef01234567'])).status, 400);
  const many = await t.db
    .collection('products')
    .find({ _id: { $ne: main._id } })
    .limit(7)
    .toArray();
  assert.equal((await setAddOns(main, ids(...many))).status, 400);
  assert.equal((await customer('PATCH', `/admin/products/${main._id}`, { addOns: [] })).status, 403);
  // Nothing changed by the refusals.
  assert.deepEqual(
    (await t.db.collection('products').findOne({ _id: main._id })).addOns.map(String),
    ids(b, soldOut, a),
  );
});

test('a new product can have add-ons, and other saves keep them', async () => {
  const category = await t.db.collection('categories').findOne();
  const res = await admin('POST', '/admin/products', {
    title: 'Phone Case',
    brand: 'Shell',
    categoryId: category._id.toString(),
    price: 29900,
    mrp: 49900,
    stock: 10,
    cost: null,
    sizeGuide: null,
    comingSoon: null,
    quantityDiscount: null,
    addOns: ids(c),
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.addOns, ids(c));
  const saved = await t.db.collection('products').findOne({ slug: 'phone-case' });
  assert.ok(saved.addOns[0].equals(c._id));

  assert.equal((await admin('PATCH', `/admin/products/${saved._id}`, { stock: 12 })).status, 200);
  assert.deepEqual((await admin('GET', `/admin/products/${saved._id}`)).body.addOns, ids(c));
});

test("the cart's add-ons: its products' add-ons not already in it, without duplicates", async () => {
  await setAddOns(main, ids(b, soldOut, a));
  await setAddOns(c, ids(a, main, b));
  const cart = (list) => t.call('GET', `/add-ons?ids=${list.join(',')}`);

  // main's add-ons first, then c's that aren't there yet; main itself is in the cart.
  let res = await cart(ids(main, c));
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.items.map((p) => p.slug),
    [b.slug, a.slug],
  );
  res = await cart(ids(c));
  assert.deepEqual(
    res.body.items.map((p) => p.slug),
    [a.slug, main.slug, b.slug],
  );
  res = await cart(ids(c, a));
  assert.deepEqual(
    res.body.items.map((p) => p.slug),
    [main.slug, b.slug],
  );
  assert.deepEqual((await cart([])).body.items, []);
  assert.equal((await t.call('GET', '/add-ons?ids=nope')).status, 400);
});
