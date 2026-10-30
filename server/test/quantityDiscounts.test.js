import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyQuantityDiscounts, unitSaving } from '../src/quantityDiscounts.js';
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

async function register(email, name) {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name, email, password: 'password123' });
  assert.equal(res.status, 201);
  return call;
}

const BOOK = 'the-quiet-engineer-paperback'; // ₹349
const PHONE = 'orbit-a14-4gb-ram-64gb'; // ₹8,999
const SHOES = 'stride-running-shoes'; // sizes
const product = (slug) => t.db.collection('products').findOne({ slug });
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
const offer = async (slug, quantityDiscount) =>
  admin('PATCH', `/admin/products/${(await product(slug))._id}`, { quantityDiscount });
const quote = (lines) =>
  customer(
    'GET',
    `/cart?items=${lines.map((l) => `${l.productId}${l.variantId ? `.${l.variantId}` : ''}:${l.qty}`).join(',')}`,
  );

test('the saving per unit is whole rupees, rounded down; bundled units and other products are left alone', () => {
  assert.equal(unitSaving(34900, 10), 3400); // ₹34.90 → ₹34
  assert.equal(unitSaving(9900, 1), 0); // under a rupee: nothing
  const offers = new Map([['a', { minQty: 3, percent: 10 }]]);
  const { parts, saving } = applyQuantityDiscounts(
    [
      { productId: 'a', qty: 1, price: 20000, bundle: { id: 'x' } },
      { productId: 'a', qty: 2, price: 20000, bundle: null },
      { productId: 'b', qty: 5, price: 20000, bundle: null },
    ],
    offers,
  );
  assert.equal(saving, 0); // only 2 units outside the bundle
  assert.equal(parts[1].price, 20000);
  const three = applyQuantityDiscounts([{ productId: 'a', qty: 3, price: 20000, bundle: null }], offers);
  assert.deepEqual(three.parts[0], {
    productId: 'a',
    qty: 3,
    price: 18000,
    bundle: null,
    regularPrice: 20000,
    quantityDiscount: { minQty: 3, percent: 10 },
  });
  assert.equal(three.saving, 6000);
});

test('admins set an offer (checked and logged); the shop shows it', async () => {
  for (const [bad, error] of [
    [{ minQty: 1, percent: 10 }, 'At least 2'],
    [{ minQty: 3, percent: 60 }, 'At most 50%'],
    [{ minQty: 3, percent: 2.5 }, 'Whole percentages only'],
  ]) {
    const res = await offer(BOOK, bad);
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes(error), res.body.error);
  }
  const res = await offer(BOOK, { minQty: 3, percent: 10 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.quantityDiscount, { minQty: 3, percent: 10 });
  assert.deepEqual((await t.call('GET', `/products/${BOOK}`)).body.quantityDiscount, { minQty: 3, percent: 10 });
  const log = await t.db.collection('activity').findOne({ 'changes.field': 'Quantity discount' });
  assert.deepEqual(
    log.changes.find((c) => c.field === 'Quantity discount'),
    { field: 'Quantity discount', from: 'none', to: '10% off from 3' },
  );
  assert.equal(
    (await customer('PATCH', `/admin/products/${(await product(BOOK))._id}`, { quantityDiscount: null })).status,
    403,
  );
});

test('the cart applies it from the minimum, and the order keeps the lower prices', async () => {
  const book = await product(BOOK);
  const id = book._id.toString();

  const two = (await quote([{ productId: id, qty: 2 }])).body;
  assert.deepEqual(two.items[0].quantityDiscount, { minQty: 3, percent: 10 });
  assert.equal(two.items[0].quantityPrice, null);
  assert.equal(two.quantitySaving, 0);

  const three = (await quote([{ productId: id, qty: 3 }])).body;
  assert.equal(three.items[0].quantityPrice, 31500);
  assert.equal(three.quantitySaving, 10200);
  assert.equal(three.itemsTotal, 104700);
  assert.equal(three.subtotal, 94500);
  assert.equal(three.total, 94500); // free delivery

  const res = await customer('POST', '/orders', {
    items: [{ productId: id, qty: 3 }],
    address,
    expectedTotal: three.total,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.quantitySaving, 10200);
  assert.equal(res.body.items[0].price, 31500);
  assert.equal(res.body.items[0].regularPrice, 34900);
  assert.deepEqual(res.body.items[0].quantityDiscount, { minQty: 3, percent: 10 });

  // Cancelling one before shipping keeps the price paid for the rest.
  const cancelled = await customer('POST', `/orders/${res.body.id}/cancel-items`, { items: [{ index: 0, qty: 1 }] });
  assert.equal(cancelled.body.total, 63000);
  assert.equal(cancelled.body.quantitySaving, 6800);
});

test('units of different sizes count together; bundled units don’t count', async () => {
  const shoes = await product(SHOES);
  await offer(SHOES, { minQty: 2, percent: 20 });
  const [a, b] = shoes.variants.filter((v) => v.stock > 0);
  const lines = [
    { productId: shoes._id.toString(), variantId: a._id.toString(), qty: 1 },
    { productId: shoes._id.toString(), variantId: b._id.toString(), qty: 1 },
  ];
  const sizes = (await quote(lines)).body;
  assert.equal(sizes.items[0].quantityPrice, a.price - unitSaving(a.price, 20));
  assert.equal(sizes.items[1].quantityPrice, b.price - unitSaving(b.price, 20));
  assert.equal(sizes.quantitySaving, unitSaving(a.price, 20) + unitSaving(b.price, 20));

  // A book + phone bundle takes one book: two left, under the minimum of three.
  const book = await product(BOOK);
  const phone = await product(PHONE);
  const bundle = await admin('POST', '/admin/bundles', {
    name: 'Read and call',
    productIds: [book._id.toString(), phone._id.toString()],
    price: book.price + phone.price - 10000,
  });
  assert.equal(bundle.status, 201, JSON.stringify(bundle.body));
  const mixed = (
    await quote([
      { productId: book._id.toString(), qty: 3 },
      { productId: phone._id.toString(), qty: 1 },
    ])
  ).body;
  assert.equal(mixed.bundleSaving, 10000);
  assert.equal(mixed.quantitySaving, 0);
  assert.equal(mixed.items[0].quantityPrice, null);
  // A fourth book makes three outside the bundle.
  const four = (
    await quote([
      { productId: book._id.toString(), qty: 4 },
      { productId: phone._id.toString(), qty: 1 },
    ])
  ).body;
  assert.equal(four.quantitySaving, 3 * 3400);
  assert.equal(four.subtotal, 4 * 34900 + 899900 - 10000 - 3 * 3400);
});
