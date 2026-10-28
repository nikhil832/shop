import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
before(async () => {
  t = await startTestServer();
});
after(() => t.stop());

const compare = (slugs) => t.call('GET', `/compare?slugs=${slugs.join(',')}`);
const SHOES = 'stride-running-shoes'; // Fashion, sizes
const JEANS = 'urbane-men-slim-fit-jeans'; // Fashion, colour × waist
const BOOK = 'the-quiet-engineer-paperback'; // Books

test('compares products in the order asked, with what a comparison needs', async () => {
  const res = await compare([JEANS, SHOES]);
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.items.map((p) => p.slug),
    [JEANS, SHOES],
  );
  assert.equal(res.body.sameCategory, true);
  const [jeans, shoes] = res.body.items;
  assert.deepEqual(jeans.category.slug, 'fashion');
  assert.equal(jeans.categoryId, jeans.category.id);
  assert.ok(jeans.highlights.length > 0);
  assert.deepEqual(jeans.options, ['Colour', 'Waist']);
  assert.ok(jeans.variants.some((v) => v.label === 'Blue / 30' && v.stock === 0));
  assert.equal(shoes.options.length, 1);
  // The card's own fields are all there (price, rating, stock…).
  const card = (await t.call('GET', `/products/${SHOES}`)).body;
  for (const key of ['price', 'mrp', 'rating', 'stock', 'image', 'brand', 'priceFrom']) {
    assert.deepEqual(shoes[key], card[key], key);
  }
});

test('products without options have none; other categories are flagged; repeats count once', async () => {
  const res = await compare([BOOK, SHOES, BOOK]);
  assert.deepEqual(
    res.body.items.map((p) => [p.slug, p.options.length, p.variants.length]),
    [
      [BOOK, 0, 0],
      [SHOES, 1, res.body.items[1].variants.length],
    ],
  );
  assert.equal(res.body.sameCategory, false);
});

test('hidden and unknown products drop out; more than three or bad addresses are refused', async () => {
  await t.db.collection('products').updateOne({ slug: SHOES }, { $set: { active: false } });
  try {
    const res = await compare([SHOES, 'no-such-thing', BOOK]);
    assert.deepEqual(
      res.body.items.map((p) => p.slug),
      [BOOK],
    );
  } finally {
    await t.db.collection('products').updateOne({ slug: SHOES }, { $set: { active: true } });
  }
  assert.deepEqual((await t.call('GET', '/compare?slugs=')).body, { items: [], sameCategory: true });
  assert.equal((await compare(['a', 'b', 'c', 'd'])).status, 400);
  assert.equal((await compare(['Not/A/Slug'])).status, 400);
});
