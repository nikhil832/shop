import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let buyer;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  buyer = await register('buyer@example.com');
});
after(() => t.stop());

async function register(email) {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name: 'Asha Rao', email, password: 'password123' });
  assert.equal(res.status, 201);
  return call;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const SHOES = 'stride-running-shoes'; // sample sizes UK 7–10 at ₹2,499, stock 15/20/10/5 (50 in all)
const KURTA = 'urbane-women-kurta-set'; // S, M, L at ₹1,499 and XL at ₹1,599
const product = (slug) => t.db.collection('products').findOne({ slug });
const variant = (doc, label) => doc.variants.find((v) => v.label === label);
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
const key = (i) => (i.variantId ? `${i.productId}.${i.variantId}` : i.productId);
const quote = (items) => buyer('GET', `/cart?items=${items.map((i) => `${key(i)}:${i.qty}`).join(',')}`);
async function order(items) {
  const q = await quote(items);
  return buyer('POST', '/orders', { items, address, expectedTotal: q.body.total });
}

test('product pages list the variants; cards name the option and say "from" when prices differ', async () => {
  const shoes = (await t.call('GET', `/products/${SHOES}`)).body;
  assert.equal(shoes.variantName, 'Size');
  assert.deepEqual(
    shoes.variants.map((v) => [v.label, v.price, v.stock]),
    [
      ['UK 7', 249900, 15],
      ['UK 8', 249900, 20],
      ['UK 9', 249900, 10],
      ['UK 10', 249900, 5],
    ],
  );
  assert.equal(shoes.stock, 50);
  assert.equal(shoes.priceFrom, false);

  const kurta = (await t.call('GET', `/products/${KURTA}`)).body;
  assert.equal(kurta.price, 149900);
  assert.equal(kurta.priceFrom, true);
  // Products without variants are unchanged.
  const book = (await t.call('GET', '/products/the-quiet-engineer-paperback')).body;
  assert.equal(book.variantName, null);
  assert.deepEqual(book.variants, []);
});

test("the cart quotes each variant at its own price and stock, and asks for one when it's missing", async () => {
  const kurta = await product(KURTA);
  const id = kurta._id.toString();
  const xl = variant(kurta, 'XL')._id.toString();
  const s = variant(kurta, 'S')._id.toString();
  const res = await quote([
    { productId: id, variantId: xl, qty: 2 },
    { productId: id, variantId: s, qty: 1 },
  ]);
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.items.map((l) => [l.variant.label, l.variant.name, l.price, l.lineTotal, l.problem]),
    [
      ['XL', 'Size', 159900, 319800, null],
      ['S', 'Size', 149900, 149900, null],
    ],
  );
  assert.equal(res.body.subtotal, 469700);
  assert.equal(res.body.canCheckout, true);

  const problems = await quote([
    { productId: id, qty: 1 },
    { productId: id, variantId: xl, qty: 6 },
    { productId: id, variantId: '0'.repeat(24), qty: 1 },
  ]);
  assert.deepEqual(
    problems.body.items.map((l) => l.problem),
    ['Choose a size', 'Only 5 left', 'No longer available'],
  );
  assert.equal(problems.body.canCheckout, false);

  // The same variant twice is a duplicate; two variants of one product are not.
  const twice = await buyer('GET', `/cart?items=${id}.${xl}:1,${id}.${xl}:1`);
  assert.equal(twice.status, 400);
});

test("ordering a variant takes its stock and the product's total; cancelling gives both back", async () => {
  const before = await product(SHOES);
  const uk8 = variant(before, 'UK 8');
  const uk9 = variant(before, 'UK 9');
  const res = await order([
    { productId: before._id.toString(), variantId: uk8._id.toString(), qty: 2 },
    { productId: before._id.toString(), variantId: uk9._id.toString(), qty: 1 },
  ]);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(
    res.body.items.map((i) => [i.title, i.variant, i.variantId, i.qty, i.price]),
    [
      ['Stride Running Shoes (Size: UK 8)', 'UK 8', uk8._id.toString(), 2, 249900],
      ['Stride Running Shoes (Size: UK 9)', 'UK 9', uk9._id.toString(), 1, 249900],
    ],
  );
  let after = await product(SHOES);
  assert.equal(variant(after, 'UK 8').stock, uk8.stock - 2);
  assert.equal(variant(after, 'UK 9').stock, uk9.stock - 1);
  assert.equal(after.stock, before.stock - 3);

  assert.equal((await buyer('POST', `/orders/${res.body.id}/cancel`)).status, 200);
  after = await product(SHOES);
  assert.equal(variant(after, 'UK 8').stock, uk8.stock);
  assert.equal(variant(after, 'UK 9').stock, uk9.stock);
  assert.equal(after.stock, before.stock);
});

test('a short variant or a missing choice refuses the whole order and changes nothing', async () => {
  const shoes = await product(SHOES);
  const kurta = await product(KURTA);
  const uk10 = variant(shoes, 'UK 10');
  const m = variant(kurta, 'M');
  const items = [
    { productId: kurta._id.toString(), variantId: m._id.toString(), qty: 1 },
    { productId: shoes._id.toString(), variantId: uk10._id.toString(), qty: 6 },
  ];
  const short = await buyer('POST', '/orders', { items, address, expectedTotal: 0 });
  assert.equal(short.status, 409);
  assert.equal(short.body.error, 'Only 5 left of Stride Running Shoes (Size: UK 10)');

  const noChoice = await buyer('POST', '/orders', {
    items: [{ productId: shoes._id.toString(), qty: 1 }],
    address,
    expectedTotal: shoes.price,
  });
  assert.equal(noChoice.status, 409);
  assert.equal(noChoice.body.error, 'Choose a size for Stride Running Shoes');

  // The kurta's M (taken first in the failed order) is untouched.
  assert.equal(variant(await product(KURTA), 'M').stock, m.stock);
  assert.equal((await product(KURTA)).stock, kurta.stock);
});

test('admins create products with variants; the product price, MRP and stock follow them', async () => {
  const categoryId = (await t.db.collection('categories').findOne({ slug: 'fashion' }))._id.toString();
  const base = { title: 'Ziva Silk Scarf', brand: 'Ziva', categoryId };

  for (const [body, error] of [
    [{ ...base, variants: [{ label: 'Red', price: 59900, mrp: 79900, stock: 3 }] }, 'variantName: Name the option'],
    [
      {
        ...base,
        variantName: 'Colour',
        variants: [
          { label: 'Red', price: 59900, mrp: 79900, stock: 3 },
          { label: 'red', price: 59900, mrp: 79900, stock: 3 },
        ],
      },
      'Each variant needs a different label',
    ],
    [
      { ...base, variantName: 'Colour', variants: [{ label: 'Red', price: 89900, mrp: 79900, stock: 3 }] },
      "A variant's MRP must be at least its price",
    ],
    [base, 'price: Enter the price'],
  ]) {
    const res = await admin('POST', '/admin/products', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.error.includes(error), `${res.body.error} / ${error}`);
  }

  const created = await admin('POST', '/admin/products', {
    ...base,
    variantName: 'Colour',
    variants: [
      { label: 'Red', price: 69900, mrp: 99900, stock: 3 },
      { label: 'Blue', price: 59900, mrp: 79900, stock: 4 },
    ],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.variantName, 'Colour');
  assert.deepEqual([created.body.price, created.body.mrp, created.body.stock], [59900, 79900, 7]);

  // Editing keeps each variant's id (so carts and orders stay attached) and recomputes the totals.
  const [red, blue] = created.body.variants;
  const edited = await admin('PATCH', `/admin/products/${created.body.id}`, {
    variantName: 'Colour',
    variants: [
      { id: red.id, label: 'Red', price: 49900, mrp: 99900, stock: 10 },
      { id: blue.id, label: 'Navy blue', price: 59900, mrp: 79900, stock: 0 },
      { label: 'Green', price: 59900, mrp: 79900, stock: 2 },
    ],
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(
    edited.body.variants.map((v) => [v.id === red.id, v.id === blue.id, v.label]),
    [
      [true, false, 'Red'],
      [false, true, 'Navy blue'],
      [false, false, 'Green'],
    ],
  );
  assert.deepEqual([edited.body.price, edited.body.mrp, edited.body.stock], [49900, 99900, 12]);

  // The product's own price or stock can't be edited while it has variants…
  const direct = await admin('PATCH', `/admin/products/${created.body.id}`, { stock: 99 });
  assert.equal(direct.status, 400);
  assert.equal(direct.body.error, 'This product has variants: change the price and stock of each one');
  // …but other fields can, and switching variants off takes the product's own numbers.
  assert.equal((await admin('PATCH', `/admin/products/${created.body.id}`, { brand: 'Ziva Home' })).status, 200);
  const off = await admin('PATCH', `/admin/products/${created.body.id}`, {
    variants: [],
    price: 54900,
    mrp: 79900,
    stock: 9,
  });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual([off.body.variantName, off.body.variants, off.body.stock], ['', [], 9]);
  const stored = await t.db.collection('products').findOne({ slug: created.body.slug });
  assert.equal(stored.variants, undefined);
});

test('a sold-out variant can still be ordered in another size, and back-in-stock waits for the whole product', async () => {
  const kurta = await product(KURTA);
  const xl = variant(kurta, 'XL');
  await t.db
    .collection('products')
    .updateOne(
      { _id: kurta._id, 'variants._id': xl._id },
      { $set: { 'variants.$.stock': 0 }, $inc: { stock: -xl.stock } },
    );
  const res = await quote([{ productId: kurta._id.toString(), variantId: xl._id.toString(), qty: 1 }]);
  assert.equal(res.body.items[0].problem, 'Out of stock');
  // The product as a whole is in stock, so it can't be watched for a restock.
  assert.equal((await buyer('PUT', `/stock-alerts/${kurta._id}`)).status, 409);
});

test("a variant's photos are among the product's; cart and order lines use the variant's first photo", async () => {
  const bag = await product('ziva-women-handbag');
  const tan = variant(bag, 'Tan');
  assert.deepEqual(tan.images, [bag.images[1]]);
  const page = (await t.call('GET', '/products/ziva-women-handbag')).body;
  assert.deepEqual(page.variants.find((v) => v.label === 'Tan').images, [bag.images[1]]);

  const items = [{ productId: bag._id.toString(), variantId: tan._id.toString(), qty: 1 }];
  assert.equal((await quote(items)).body.items[0].image, bag.images[1]);
  const res = await order(items);
  assert.equal(res.status, 201);
  assert.equal(res.body.items[0].image, bag.images[1]);
  assert.equal((await buyer('POST', `/orders/${res.body.id}/cancel`)).status, 200);
});

test("admins pick each variant's photos from the product's; removing a photo drops it from the variants", async () => {
  const categoryId = (await t.db.collection('categories').findOne({ slug: 'fashion' }))._id.toString();
  const upload = async () => (await admin('POST', '/admin/images', PNG, 'image/png')).body.url;
  const [red, blue, other] = [await upload(), await upload(), await upload()];
  const body = {
    title: 'Ziva Tote',
    brand: 'Ziva',
    categoryId,
    images: [red, blue],
    variantName: 'Colour',
    variants: [
      { label: 'Red', price: 99900, mrp: 99900, stock: 2, images: [red] },
      { label: 'Blue', price: 99900, mrp: 99900, stock: 2, images: [other] },
    ],
  };
  const refused = await admin('POST', '/admin/products', body);
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "variants: A variant's photos must be among the product's photos");

  body.variants[1].images = [blue];
  const created = await admin('POST', '/admin/products', body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(
    created.body.variants.map((v) => v.images),
    [[red], [blue]],
  );

  // Taking the blue photo off the product takes it off the Blue variant too.
  const edited = await admin('PATCH', `/admin/products/${created.body.id}`, { images: [red] });
  assert.equal(edited.status, 200);
  assert.deepEqual(
    edited.body.variants.map((v) => v.images),
    [[red], []],
  );
});

const JEANS = 'urbane-men-slim-fit-jeans'; // Colour × Waist: Blue 30 (sold out), 32, 34; Black 30, 32 (no Black 34)
const combo = (doc, colour, waist) => doc.variants.find((v) => v.values[0] === colour && v.values[1] === waist);

test('two options: the page lists both, and lines are named by both', async () => {
  const page = (await t.call('GET', `/products/${JEANS}`)).body;
  assert.deepEqual(page.options, ['Colour', 'Waist']);
  assert.equal(page.variantName, 'Colour and waist');
  assert.deepEqual(
    page.variants.map((v) => [v.values, v.label, v.stock]),
    [
      [['Blue', '30'], 'Blue / 30', 0],
      [['Blue', '32'], 'Blue / 32', 20],
      [['Blue', '34'], 'Blue / 34', 14],
      [['Black', '30'], 'Black / 30', 12],
      [['Black', '32'], 'Black / 32', 18],
    ],
  );
  assert.equal(page.priceFrom, true);
  // One-option products list their one option.
  assert.deepEqual((await t.call('GET', `/products/${SHOES}`)).body.options, ['Size']);

  const jeans = await product(JEANS);
  const black32 = combo(jeans, 'Black', '32');
  const items = [{ productId: jeans._id.toString(), variantId: black32._id.toString(), qty: 1 }];
  const q = await quote(items);
  assert.equal(q.body.items[0].variant.description, 'Colour: Black, Waist: 32');
  assert.equal(
    (await quote([{ productId: jeans._id.toString(), qty: 1 }])).body.items[0].problem,
    'Choose a colour and waist',
  );
  const res = await order(items);
  assert.equal(res.status, 201);
  assert.equal(res.body.items[0].title, 'Urbane Men Slim Fit Jeans (Colour: Black, Waist: 32)');
  assert.equal(res.body.items[0].variant, 'Black / 32');
  assert.equal(variant(await product(JEANS), 'Black / 32').stock, black32.stock - 1);
  assert.equal((await buyer('POST', `/orders/${res.body.id}/cancel`)).status, 200);

  // A sold-out combination can be watched while the rest are in stock.
  const blue30 = combo(jeans, 'Blue', '30');
  const watch = await buyer('PUT', `/stock-alerts/${jeans._id}?variant=${blue30._id}`);
  assert.equal(watch.status, 200);
  const black30 = combo(jeans, 'Black', '30');
  const inStock = await buyer('PUT', `/stock-alerts/${jeans._id}?variant=${black30._id}`);
  assert.equal(inStock.body.error, 'This colour and waist is in stock: you can buy it now');
});

test('admins give two options names and every variant a value for each, once per combination', async () => {
  const categoryId = (await t.db.collection('categories').findOne({ slug: 'fashion' }))._id.toString();
  const row = (values, stock = 1) => ({ values, price: 99900, mrp: 129900, stock });
  const base = { title: 'Urbane Chinos', brand: 'Urbane', categoryId, options: ['Colour', 'Waist'] };

  for (const [variants, error, options = base.options] of [
    [[row(['Khaki'])], 'Give each variant a value for every option'],
    [[row(['Khaki', '32']), row(['khaki', '32'])], 'Each combination can be listed once'],
    [[row(['Khaki', '32'])], 'Give the two options different names', ['Colour', 'colour']],
    [[row(['Khaki', '32', 'Slim'])], null, ['Colour', 'Waist']],
  ]) {
    const res = await admin('POST', '/admin/products', { ...base, options, variants });
    assert.equal(res.status, 400, JSON.stringify(variants));
    if (error) assert.ok(res.body.error.includes(error), `${res.body.error} / ${error}`);
  }
  const tooMany = await admin('POST', '/admin/products', {
    ...base,
    options: ['Colour', 'Waist', 'Fit'],
    variants: [row(['Khaki', '32', 'Slim'])],
  });
  assert.equal(tooMany.status, 400);

  const created = await admin('POST', '/admin/products', {
    ...base,
    variants: [row(['Khaki', '30'], 2), row(['Khaki', '32'], 3), row(['Navy', '32'], 0)],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.options, ['Colour', 'Waist']);
  assert.equal(created.body.variantName, 'Colour and waist');
  assert.deepEqual(
    created.body.variants.map((v) => v.label),
    ['Khaki / 30', 'Khaki / 32', 'Navy / 32'],
  );
  assert.equal(created.body.stock, 5);

  // Back to one option: the values become plain labels.
  const one = await admin('PATCH', `/admin/products/${created.body.id}`, {
    options: ['Waist'],
    variants: created.body.variants.slice(0, 2).map((v) => ({ id: v.id, values: [v.values[1]], ...v })),
  });
  assert.equal(one.status, 400); // still two values each
  const fixed = await admin('PATCH', `/admin/products/${created.body.id}`, {
    options: ['Waist'],
    variants: created.body.variants.slice(0, 2).map((v) => ({
      id: v.id,
      values: [v.values[1]],
      price: v.price,
      mrp: v.mrp,
      stock: v.stock,
    })),
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.deepEqual(fixed.body.options, ['Waist']);
  assert.equal(fixed.body.variantName, 'Waist');
  assert.deepEqual(
    fixed.body.variants.map((v) => v.label),
    ['30', '32'],
  );
});
