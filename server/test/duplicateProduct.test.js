import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  customer = await register('customer@example.com', 'Asha Rao');
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}

const products = () => t.db.collection('products');

test('a copy is hidden, has no stock or reviews, and keeps the details, photos and options', async () => {
  const jeans = await products().findOne({ slug: 'urbane-men-slim-fit-jeans' });
  const extras = await products()
    .find({ _id: { $ne: jeans._id } })
    .limit(2)
    .toArray();
  await products().updateOne(
    { _id: jeans._id },
    {
      $set: {
        addOns: extras.map((p) => p._id),
        quantityDiscount: { minQty: 2, percent: 10 },
        cost: 50000,
        'variants.0.cost': 40000,
        comingSoon: { expected: null },
      },
    },
  );
  const res = await admin('POST', `/admin/products/${jeans._id}/duplicate`);
  assert.equal(res.status, 201);
  const copy = res.body;
  assert.equal(copy.title, `${jeans.title} (copy)`);
  assert.equal(copy.slug, 'urbane-men-slim-fit-jeans-copy');
  assert.equal(copy.active, false);
  assert.equal(copy.stock, 0);
  assert.equal(copy.description, jeans.description);
  assert.deepEqual(copy.highlights, jeans.highlights);
  assert.deepEqual(copy.images, jeans.images);
  assert.deepEqual(copy.options, ['Colour', 'Waist']);
  assert.equal(copy.variants.length, jeans.variants.length);
  assert.ok(copy.variants.every((v) => v.stock === 0));
  assert.deepEqual(
    copy.variants.map((v) => [v.label, v.price, v.mrp]),
    jeans.variants.map((v) => [v.label, v.price, v.mrp]),
  );
  // New option ids, so carts and orders of the original never point at the copy.
  const original = new Set(jeans.variants.map((v) => v._id.toString()));
  assert.ok(copy.variants.every((v) => !original.has(v.id)));
  assert.deepEqual(
    copy.addOns,
    extras.map((p) => p._id.toString()),
  );
  assert.deepEqual(copy.quantityDiscount, { minQty: 2, percent: 10 });
  assert.equal(copy.comingSoon, null);

  const saved = await products().findOne({ slug: copy.slug });
  assert.deepEqual(saved.rating, { avg: 0, count: 0 });
  assert.equal(saved.reviewStats, undefined);
  assert.equal(saved.variants[0].cost, 40000);
  // The original is untouched, and the copy isn't in the store.
  assert.equal((await products().findOne({ _id: jeans._id })).stock, jeans.stock);
  assert.equal((await t.call('GET', `/products/${copy.slug}`)).status, 404);

  const entry = await t.db.collection('activity').findOne({ action: 'Duplicated product' });
  assert.equal(entry.target.label, copy.title);
  assert.deepEqual(entry.changes, [{ field: 'Copied from', to: jeans.title }]);

  // A second copy gets the next address.
  assert.equal((await admin('POST', `/admin/products/${jeans._id}/duplicate`)).body.slug, `${copy.slug}-2`);
});

test('a product on sale is copied at its regular prices', async () => {
  const shoes = await products().findOne({ slug: 'stride-running-shoes' });
  const regularVariants = shoes.variants.map((v) => ({ id: v._id, price: v.price }));
  await products().updateOne(
    { _id: shoes._id },
    {
      $set: {
        price: shoes.price - 10000,
        variants: shoes.variants.map((v) => ({ ...v, price: v.price - 10000 })),
        sale: {
          id: shoes._id,
          name: 'Test sale',
          percent: 10,
          endsAt: new Date(),
          regularPrice: shoes.price,
          regularVariants,
        },
      },
    },
  );
  const copy = (await admin('POST', `/admin/products/${shoes._id}/duplicate`)).body;
  assert.equal(copy.price, shoes.price);
  assert.deepEqual(
    copy.variants.map((v) => v.price),
    shoes.variants.map((v) => v.price),
  );
  assert.equal(copy.sale, null);
});

test('a product without options is copied with its price and no stock', async () => {
  const book = await products().findOne({ slug: 'the-quiet-engineer-paperback' });
  const copy = (await admin('POST', `/admin/products/${book._id}/duplicate`)).body;
  assert.equal(copy.price, book.price);
  assert.equal(copy.mrp, book.mrp);
  assert.equal(copy.stock, 0);
  assert.deepEqual(copy.variants, []);
});

test('only admins can duplicate, and only products that exist', async () => {
  const book = await products().findOne({ slug: 'the-quiet-engineer-paperback' });
  const before = await products().countDocuments();
  assert.equal((await customer('POST', `/admin/products/${book._id}/duplicate`)).status, 403);
  assert.equal((await t.call('POST', `/admin/products/${book._id}/duplicate`)).status, 401);
  await t.db.collection('users').updateOne({ email: 'customer@example.com' }, { $set: { role: 'packer' } });
  assert.equal((await customer('POST', `/admin/products/${book._id}/duplicate`)).status, 403);
  assert.equal((await admin('POST', '/admin/products/0123456789abcdef01234567/duplicate')).status, 404);
  assert.equal((await admin('POST', '/admin/products/nope/duplicate')).status, 400);
  assert.equal(await products().countDocuments(), before);
});

test("a copy's address follows its title until it's first shown, then stays", async () => {
  const book = await products().findOne({ slug: 'the-quiet-engineer-paperback' });
  const copy = (await admin('POST', `/admin/products/${book._id}/duplicate`)).body;
  const edit = (body) => admin('PATCH', `/admin/products/${copy.id}`, body);

  let res = await edit({ title: 'The Loud Engineer (Paperback)' });
  assert.equal(res.status, 200);
  assert.equal(res.body.slug, 'the-loud-engineer-paperback');
  // A title whose address is taken gets the next free one.
  res = await edit({ title: book.title });
  assert.equal(res.body.slug, 'the-quiet-engineer-paperback-2');
  res = await edit({ title: 'The Loud Engineer (Paperback)', active: true });
  assert.equal(res.body.slug, 'the-loud-engineer-paperback');
  assert.equal((await t.call('GET', '/products/the-loud-engineer-paperback')).status, 200);

  // Shown once: fixed from now on, even when hidden again.
  res = await edit({ title: 'The Quiet Engineer, Second Edition', active: false });
  assert.equal(res.body.slug, 'the-loud-engineer-paperback');
  assert.equal((await products().findOne({ _id: book._id })).slug, 'the-quiet-engineer-paperback');
  // Other products never change address.
  res = await admin('PATCH', `/admin/products/${book._id}`, { title: 'The Quiet Engineer (New Cover)' });
  assert.equal(res.body.slug, 'the-quiet-engineer-paperback');
});
