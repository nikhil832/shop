import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DEAL_PERCENT } from '../src/routes/catalog.js';
import { startTestServer } from './helpers.js';

let t;
before(async () => {
  t = await startTestServer();
});
after(() => t.stop());

const ratio = (p) => (p.mrp - p.price) / p.mrp;
const isDeal = (p) => (p.mrp - p.price) * 100 >= p.mrp * DEAL_PERCENT;

test('deals are products at least DEAL_PERCENT below MRP, biggest discount first', async () => {
  const all = await t.db.collection('products').find({ active: true }).toArray();
  const expected = all.filter(isDeal);
  assert.ok(expected.length > 8 && expected.length < all.length); // the sample catalog has both kinds

  const res = await t.call('GET', '/products?deals=1&sort=discount&pageSize=48');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, expected.length);
  assert.ok(res.body.items.every(isDeal));
  const ratios = res.body.items.map(ratio);
  assert.deepEqual(
    ratios,
    [...ratios].sort((a, b) => b - a),
  );
  assert.equal(res.body.items[0].discountRatio, undefined); // only for sorting

  // Pixelon 9 is 8% off: not a deal, but listed with the discount sort alone.
  const pixelon = all.find((p) => p.slug === 'pixelon-9-8gb-ram-256gb');
  assert.ok(!isDeal(pixelon));
  assert.ok(!res.body.items.some((p) => p.slug === pixelon.slug));
  const sorted = await t.call('GET', '/products?sort=discount&pageSize=48');
  assert.equal(sorted.body.total, 38);
  assert.ok(sorted.body.items.some((p) => p.slug === pixelon.slug));

  // With other filters and a category.
  const mobiles = await t.call('GET', '/products?deals=1&category=mobiles&inStock=1');
  assert.ok(mobiles.body.items.every((p) => isDeal(p) && p.stock > 0));
  assert.equal((await t.call('GET', '/products?deals=yes')).status, 400);
});

test('a product in a running sale is a deal whatever its discount', async () => {
  await t.db
    .collection('products')
    .updateOne({ slug: 'pixelon-9-8gb-ram-256gb' }, { $set: { sale: { id: 'x', name: 'Weekend', percent: 5 } } });
  const res = await t.call('GET', '/products?deals=1&pageSize=48');
  assert.ok(res.body.items.some((p) => p.slug === 'pixelon-9-8gb-ram-256gb'));
});
