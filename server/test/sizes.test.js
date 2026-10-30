import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sortSizes } from '../src/sizes.js';
import { startTestServer } from './helpers.js';

let t;
before(async () => {
  t = await startTestServer();
});
after(() => t.stop());

const list = async (query) => (await t.call('GET', `/products?pageSize=48&${query}`)).body;
const slugs = (body) => body.items.map((p) => p.slug).sort();

test('sizes sort letters in order, then by number per prefix, then by name', () => {
  assert.deepEqual(sortSizes(['XL', 'M', 'S', 'L']), ['S', 'M', 'L', 'XL']);
  assert.deepEqual(sortSizes(['UK 10', 'UK 7', '32', '30', 'UK 9']), ['30', '32', 'UK 7', 'UK 9', 'UK 10']);
  assert.deepEqual(sortSizes(['Free size', 'M']), ['M', 'Free size']);
});

test('the size facet lists sizes in stock among the results, with product counts', async () => {
  const fashion = await list('category=fashion');
  assert.deepEqual(
    fashion.sizes.map((s) => s.name),
    ['S', 'M', 'L', 'XL', '30', '32', '34', 'UK 7', 'UK 8', 'UK 9', 'UK 10'],
  );
  assert.ok(fashion.sizes.every((s) => s.count === 1));
  // Jeans in waist 30: Black 30 is in stock (Blue 30 isn't), so 30 is listed.
  assert.deepEqual((await list('category=mobiles')).sizes, []); // nothing there has sizes
});

test('choosing sizes shows only products with one of them in stock; the facet keeps every size', async () => {
  const uk8 = await list('size=UK 8');
  assert.deepEqual(slugs(uk8), ['stride-running-shoes']);
  assert.equal(uk8.sizes.length, 11); // the facet ignores its own filter
  assert.deepEqual(slugs(await list('size=M,32')), ['urbane-men-slim-fit-jeans', 'urbane-women-kurta-set']);

  // Sold out in that size: not shown.
  await t.db
    .collection('products')
    .updateOne(
      { slug: 'stride-running-shoes', 'variants.label': 'UK 10' },
      { $inc: { 'variants.$.stock': -5, stock: -5 } },
    );
  assert.equal((await list('size=UK 10')).total, 0);
  assert.ok(!(await list('category=fashion')).sizes.some((s) => s.name === 'UK 10'));

  // With a brand and a search too.
  assert.deepEqual(slugs(await list('size=M&brand=Urbane')), ['urbane-women-kurta-set']);
  assert.deepEqual(slugs(await list('size=UK 8&q=shoes')), ['stride-running-shoes']);
  assert.equal((await list('size=UK 8&brand=Ziva')).total, 0);
});
