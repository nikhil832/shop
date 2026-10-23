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
    'priceFrom',
    'rating',
    'slug',
    'stock',
    'title',
    'variantName',
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

const search = async (q, extra = '') =>
  (await t.call('GET', `/products?q=${encodeURIComponent(q)}&pageSize=48${extra}`)).body.items;
const categoryOf = async (p) =>
  (
    await t.db
      .collection('categories')
      .findOne({ _id: (await t.db.collection('products').findOne({ slug: p.slug })).categoryId })
  ).slug;

test('search also matches category names, highlights, plurals and a few synonyms', async () => {
  for (const q of ['laptop', 'laptops', 'notebook']) {
    const items = await search(q);
    assert.equal(items.length, 6, q);
    for (const p of items) assert.equal(await categoryOf(p), 'laptops');
  }
  // "phone" means the Mobiles category, not the headphones it is part of.
  const phones = await search('phones');
  assert.equal(phones.length, 7);
  for (const p of phones) assert.equal(await categoryOf(p), 'mobiles');

  assert.deepEqual(titles({ body: { items: await search('watches') } }), ['Ziva Analog Watch']);
  assert.ok((await search('bluetooth')).some((p) => p.title === 'Sonique Buds Pro (ANC)')); // a highlight
  const homeKitchen = (await t.call('GET', '/products?category=home-kitchen&pageSize=48')).body.total;
  assert.equal((await search('kitchen')).length, homeKitchen);
});

test('search matches whole words from their start, not inside other words', async () => {
  const books = await search('book');
  assert.equal(books.length, 5);
  assert.ok(!books.some((p) => /chromebook|arcbook/i.test(p.title)));
  assert.equal((await search('bass'))[0].title, 'Bolt Bass Neckband'); // "bass" isn't made singular
});

test('relevance ranks title and brand matches above category and highlight matches', async () => {
  // "pro" is in three titles, and only in a highlight ("splash-proof") of the speaker, which comes last.
  const pro = await search('pro');
  assert.deepEqual(
    pro
      .slice(0, 3)
      .map((p) => p.title)
      .sort(),
    ['Arcbook Pro 16 (32GB, 1TB SSD)', 'Sonique Buds Pro (ANC)', 'Voltix Nova Pro 5G (12GB RAM, 256GB)'],
  );
  assert.equal(pro.at(-1).title, 'Bolt Party Speaker 40W');

  // The exact phrase in a title wins; ties go to the more popular product.
  assert.equal((await search('nova pro'))[0].title, 'Voltix Nova Pro 5G (12GB RAM, 256GB)');
  const laptops = await search('laptop');
  const counts = laptops.map((p) => p.rating.count);
  assert.deepEqual(
    counts,
    [...counts].sort((a, b) => b - a),
  );

  // Other sorts still apply to search results.
  const cheap = (await search('laptop', '&sort=price_asc')).map((p) => p.price);
  assert.deepEqual(
    cheap,
    [...cheap].sort((a, b) => a - b),
  );
});

const suggest = async (q) => (await t.call('GET', `/search/suggest?q=${encodeURIComponent(q)}`)).body;

test('suggests categories and the best products while typing', async () => {
  // A partial word already finds the category and its products.
  const lapt = await suggest('lapt');
  assert.deepEqual(lapt.categories, [{ slug: 'laptops', name: 'Laptops' }]);
  assert.equal(lapt.total, 6);
  assert.equal(lapt.products.length, 6);
  assert.deepEqual(Object.keys(lapt.products[0]).sort(), ['brand', 'price', 'slug', 'title']);

  // Ranked like the relevance sort: the exact title first.
  const nova = await suggest('nova pro');
  assert.equal(nova.products[0].title, 'Voltix Nova Pro 5G (12GB RAM, 256GB)');
  assert.deepEqual(nova.categories, []);

  // At most 6 products, but the total counts them all.
  const camera = await suggest('camera');
  assert.equal(camera.products.length, 6);
  assert.ok(camera.total > 6);

  assert.deepEqual(await suggest('zzzz'), { categories: [], products: [], total: 0 });
  const empty = await t.call('GET', '/search/suggest?q=%20');
  assert.equal(empty.status, 400);
});

test('suggestions leave out hidden products', async () => {
  const products = t.db.collection('products');
  await products.updateOne({ slug: 'bolt-bass-neckband' }, { $set: { active: false } });
  try {
    assert.equal((await suggest('neckband')).total, 0);
  } finally {
    await products.updateOne({ slug: 'bolt-bass-neckband' }, { $set: { active: true } });
  }
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
