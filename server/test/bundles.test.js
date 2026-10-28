import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyBundles, shareSaving } from '../src/bundles.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
let bookA;
let bookB;
let bookC;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  customer = await register('customer@example.com', 'Asha Rao');
  const books = await t.db
    .collection('products')
    .find({ 'variants.0': { $exists: false }, stock: { $gte: 10 }, active: true })
    .sort({ price: 1 })
    .limit(3)
    .toArray();
  [bookA, bookB, bookC] = books;
});
after(() => t.stop());

async function register(email, name) {
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
const cartOf = (lines) => lines.map(([p, qty]) => `${p._id}:${qty}`).join(',');
const quote = async (lines, coupon) =>
  (await customer('GET', `/cart?items=${cartOf(lines)}${coupon ? `&coupon=${coupon}` : ''}`)).body;
async function order(lines, couponCode) {
  const q = await quote(lines, couponCode);
  const res = await customer('POST', '/orders', {
    items: lines.map(([p, qty]) => ({ productId: p._id.toString(), qty })),
    address,
    expectedTotal: q.total,
    ...(couponCode && { couponCode }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('a set’s saving is shared by price in whole rupees; full sets get it, the rest pays full price', () => {
  assert.deepEqual(shareSaving([30000, 10000], 4000), [3000, 1000]);
  assert.deepEqual(shareSaving([29900, 79900], 29900), [8100, 21800]);
  const b = { _id: 'b1', name: 'Pair', productIds: ['a', 'b'], price: 30000 };
  const { parts, applied, saving } = applyBundles(
    [
      { productId: 'a', variantId: null, qty: 3, price: 20000 },
      { productId: 'b', variantId: null, qty: 2, price: 20000 },
    ],
    [b],
  );
  assert.deepEqual(applied, [{ id: 'b1', name: 'Pair', sets: 2, saving: 20000 }]);
  assert.equal(saving, 20000);
  assert.deepEqual(
    parts.map((ps) => ps.map((p) => [p.qty, p.price, p.bundle?.name ?? null])),
    [
      [
        [2, 15000, 'Pair'],
        [1, 20000, null],
      ],
      [[2, 15000, 'Pair']],
    ],
  );
  // Not a full set, or no saving at today's prices: nothing.
  assert.equal(applyBundles([{ productId: 'a', variantId: null, qty: 1, price: 20000 }], [b]).saving, 0);
  assert.equal(
    applyBundles(
      [
        { productId: 'a', variantId: null, qty: 1, price: 10000 },
        { productId: 'b', variantId: null, qty: 1, price: 10000 },
      ],
      [b],
    ).saving,
    0,
  );
});

test('admins make bundles of simple products, cheaper than buying them apart', async () => {
  const shoes = await t.db.collection('products').findOne({ slug: 'stride-running-shoes' });
  const regular = bookA.price + bookB.price;
  for (const [body, error] of [
    [{ name: 'Solo', productIds: [bookA._id.toString()], price: 100 }, 'Choose 2 or 3 products'],
    [{ name: 'Twice', productIds: [bookA._id.toString(), bookA._id.toString()], price: 100 }, 'Each product once'],
    [{ name: 'Shoes', productIds: [bookA._id.toString(), shoes._id.toString()], price: 100 }, 'has sizes or colours'],
    [{ name: 'Dear', productIds: [bookA._id.toString(), bookB._id.toString()], price: regular }, 'Below'],
    [{ name: 'Paise', productIds: [bookA._id.toString(), bookB._id.toString()], price: 10050 }, 'Whole rupees'],
  ]) {
    const res = await admin('POST', '/admin/bundles', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.error.includes(error), `${res.body.error} / ${error}`);
  }
  const price = Math.floor((regular - 10000) / 100) * 100;
  const res = await admin('POST', '/admin/bundles', {
    name: 'Reading pair',
    productIds: [bookA._id.toString(), bookB._id.toString()],
    price,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual([res.body.regular, res.body.saving], [regular, regular - price]);
  assert.equal((await customer('POST', '/admin/bundles', {})).status, 403);
  assert.ok(await t.db.collection('activity').findOne({ area: 'bundles', action: 'Added bundle' }));
});

test('the cart takes the saving off when it holds a full set; the order stores bundled units at bundle prices', async () => {
  const bundle = await t.db.collection('bundles').findOne({ name: 'Reading pair' });
  const saving = bookA.price + bookB.price - bundle.price;
  const q = await quote([
    [bookA, 2],
    [bookB, 1],
  ]);
  assert.deepEqual(q.bundles, [{ id: bundle._id.toString(), name: 'Reading pair', sets: 1, saving }]);
  assert.equal(q.itemsTotal, 2 * bookA.price + bookB.price);
  assert.equal(q.subtotal, q.itemsTotal - saving);

  const placed = await order([
    [bookA, 2],
    [bookB, 1],
  ]);
  assert.equal(placed.bundleSaving, saving);
  assert.equal(placed.total, q.total);
  assert.deepEqual(
    placed.items.map((i) => [i.productId, i.qty, i.bundle?.name ?? null]),
    [
      [bookA._id.toString(), 1, 'Reading pair'],
      [bookA._id.toString(), 1, null],
      [bookB._id.toString(), 1, 'Reading pair'],
    ],
  );
  const bundledPrices = placed.items.filter((i) => i.bundle).reduce((s, i) => s + i.price, 0);
  assert.equal(bundledPrices, bundle.price);
  assert.equal(placed.items[0].regularPrice, bookA.price);
  // Stock went down by what was bought, whatever the split.
  assert.equal((await t.db.collection('products').findOne({ _id: bookA._id })).stock, bookA.stock - 2);
});

test('coupons apply after the bundle saving', async () => {
  assert.equal((await admin('POST', '/admin/coupons', { code: 'BUNDLE10', type: 'percent', value: 10 })).status, 201);
  const q = await quote(
    [
      [bookA, 1],
      [bookB, 1],
    ],
    'BUNDLE10',
  );
  const bundle = await t.db.collection('bundles').findOne({ name: 'Reading pair' });
  assert.equal(q.subtotal, bundle.price);
  assert.equal(q.discount, Math.floor(bundle.price / 1000) * 100); // 10% of the bundle price, whole rupees
});

test('a returned bundled item refunds what was paid for it', async () => {
  const placed = await order([
    [bookA, 1],
    [bookB, 1],
  ]);
  for (const status of ['shipped', 'delivered']) {
    await admin('POST', `/admin/orders/${placed.id}/status`, { status });
  }
  const ret = await customer('POST', `/orders/${placed.id}/returns`, {
    items: [{ index: 0, qty: 1 }],
    reason: 'damaged',
  });
  assert.equal(ret.status, 201, JSON.stringify(ret.body));
  assert.equal(ret.body.refund, placed.items[0].price);
  assert.ok(placed.items[0].price < bookA.price);
});

test('product pages show their bundles while they save something; switched off, they stop applying', async () => {
  const bundle = await t.db.collection('bundles').findOne({ name: 'Reading pair' });
  const shown = (await t.call('GET', `/products/${bookB.slug}/bundles`)).body.items;
  assert.deepEqual(
    shown.map((b) => [b.name, b.products.length, b.inStock]),
    [['Reading pair', 2, true]],
  );
  assert.deepEqual((await t.call('GET', `/products/${bookC.slug}/bundles`)).body.items, []);

  const off = await admin('PATCH', `/admin/bundles/${bundle._id}`, { active: false });
  assert.equal(off.body.active, false);
  assert.deepEqual((await t.call('GET', `/products/${bookB.slug}/bundles`)).body.items, []);
  assert.equal(
    (
      await quote([
        [bookA, 1],
        [bookB, 1],
      ])
    ).bundleSaving,
    0,
  );
  assert.equal((await admin('PATCH', `/admin/bundles/${bundle._id}`, { active: true })).status, 200);
  const log = await t.db.collection('activity').findOne({ action: 'Changed bundle' });
  assert.deepEqual(log.changes[0], { field: 'Shown', from: 'yes', to: 'no' });
});
