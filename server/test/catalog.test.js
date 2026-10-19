import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
before(async () => (t = await startTestServer()));
after(() => t.stop());

const titles = (res) => res.body.items.map((p) => p.title);

test('lists categories in display order', async () => {
  const res = await t.call('GET', '/categories');
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.map((c) => c.slug),
    ['mobiles', 'laptops', 'audio', 'fashion', 'home-kitchen', 'books'],
  );
});

test('lists products with paging and totals', async () => {
  const all = await t.call('GET', '/products?pageSize=48');
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 38);
  assert.equal(all.body.items.length, 38);

  const page2 = await t.call('GET', '/products?pageSize=10&page=2');
  assert.equal(page2.body.items.length, 10);
  assert.equal(page2.body.total, 38);
  assert.deepEqual(titles(page2), titles(all).slice(10, 20));

  const card = all.body.items[0];
  assert.deepEqual(Object.keys(card).sort(), [
    'brand',
    'id',
    'image',
    'mrp',
    'price',
    'rating',
    'slug',
    'stock',
    'title',
  ]);
});

test('filters by category, brand, price, rating and stock', async () => {
  const mobiles = await t.call('GET', '/products?category=mobiles&pageSize=48');
  assert.equal(mobiles.body.total, 7);
  assert.deepEqual(
    mobiles.body.brands.map((b) => [b.name, b.count]),
    [
      ['Kiran', 1],
      ['Orbit', 2],
      ['Pixelon', 2],
      ['Voltix', 2],
    ],
  );

  // Brand facet keeps listing every brand in the category even when filtering by one.
  const voltix = await t.call('GET', '/products?category=mobiles&brand=Voltix,Orbit');
  assert.equal(voltix.body.total, 4);
  assert.equal(voltix.body.brands.length, 4);

  const cheap = await t.call('GET', '/products?minPrice=50000&maxPrice=100000&pageSize=48');
  assert.ok(cheap.body.items.every((p) => p.price >= 50000 && p.price <= 100000));
  assert.ok(cheap.body.total > 0);

  const inStock = await t.call('GET', '/products?inStock=1&pageSize=48');
  assert.equal(inStock.body.total, 33);
  assert.ok(inStock.body.items.every((p) => p.stock > 0));

  const rated = await t.call('GET', '/products?rating=4.5&pageSize=48');
  assert.ok(rated.body.items.every((p) => p.rating.avg >= 4.5));

  const unknown = await t.call('GET', '/products?category=nope');
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.total, 0);
});

test('searches every word across title and brand, case-insensitively', async () => {
  const res = await t.call('GET', `/products?q=${encodeURIComponent('voltix PRO')}`);
  assert.deepEqual(titles(res), ['Voltix Nova Pro 5G (12GB RAM, 256GB)']);

  const brand = await t.call('GET', '/products?q=sonique&pageSize=48');
  assert.equal(brand.body.total, 2);

  // Regex characters are matched literally.
  const special = await t.call('GET', `/products?q=${encodeURIComponent('(8GB')}&pageSize=48`);
  assert.ok(special.body.total >= 3);
  assert.equal((await t.call('GET', `/products?q=${encodeURIComponent('.*')}`)).body.total, 0);
});

test('sorts by price, newest and rating', async () => {
  const asc = (await t.call('GET', '/products?sort=price_asc&pageSize=48')).body.items.map((p) => p.price);
  assert.deepEqual(
    asc,
    [...asc].sort((a, b) => a - b),
  );
  const desc = (await t.call('GET', '/products?sort=price_desc&pageSize=48')).body.items.map((p) => p.price);
  assert.deepEqual(desc, [...asc].reverse());

  const newest = await t.call('GET', '/products?sort=newest&pageSize=1');
  assert.equal(newest.body.items[0].title, 'Cooking Without Fuss');

  const rating = (await t.call('GET', '/products?sort=rating&pageSize=48')).body.items.map((p) => p.rating.avg);
  assert.deepEqual(
    rating,
    [...rating].sort((a, b) => b - a),
  );
});

test('rejects invalid list queries', async () => {
  for (const qs of ['sort=random', 'page=0', 'pageSize=500', 'minPrice=-1', 'rating=9', 'inStock=yes']) {
    const res = await t.call('GET', `/products?${qs}`);
    assert.equal(res.status, 400, qs);
    assert.match(res.body.error, /\w/);
  }
});

test('returns product details by slug, and 404 for unknown or inactive products', async () => {
  const res = await t.call('GET', '/products/arcbook-air-14-16gb-512gb-ssd');
  assert.equal(res.status, 200);
  assert.equal(res.body.brand, 'Arcbook');
  assert.equal(res.body.price, 6499000);
  assert.equal(res.body.images.length, 3);
  assert.equal(res.body.highlights.length, 3);
  assert.equal(res.body.category.slug, 'laptops');

  assert.equal((await t.call('GET', '/products/does-not-exist')).status, 404);
  await t.db.collection('products').updateOne({ slug: 'bolt-bass-neckband' }, { $set: { active: false } });
  assert.equal((await t.call('GET', '/products/bolt-bass-neckband')).status, 404);
  const search = await t.call('GET', '/products?q=neckband');
  assert.equal(search.body.total, 0);
});

test('unknown API routes return JSON 404', async () => {
  const res = await t.call('GET', '/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Not found');
});
