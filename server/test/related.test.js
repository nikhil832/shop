import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
before(async () => (t = await startTestServer()));
after(() => t.stop());

const slugs = (res) => res.body.items.map((p) => p.slug);
const NOVA = 'voltix-nova-5g-8gb-ram-128gb';

test('similar products: same brand and category first, then the category; in stock before sold out', async () => {
  const res = await t.call('GET', `/products/${NOVA}/related`);
  assert.equal(res.status, 200);
  assert.ok(res.body.items.length > 0 && res.body.items.length <= 8);
  assert.equal(slugs(res)[0], 'voltix-nova-pro-5g-12gb-ram-256gb');
  assert.ok(!slugs(res).includes(NOVA));
  assert.deepEqual(Object.keys(res.body.items[0]), Object.keys((await t.call('GET', '/products')).body.items[0]));

  const mobiles = await t.db.collection('categories').findOne({ slug: 'mobiles' });
  const docs = await t.db
    .collection('products')
    .find({ slug: { $in: slugs(res) } })
    .toArray();
  assert.ok(docs.every((d) => d.categoryId.equals(mobiles._id) || d.brand === 'Voltix'));
  // Pixelon 9 is sold out: it comes after every other phone.
  const stock = slugs(res).map((s) => docs.find((d) => d.slug === s).stock);
  const firstSoldOut = stock.indexOf(0);
  assert.ok(firstSoldOut === -1 || stock.slice(firstSoldOut).every((n) => n === 0));
});

test('hidden products are neither shown as similar nor given similar ones', async () => {
  const products = t.db.collection('products');
  await products.updateOne({ slug: 'voltix-nova-pro-5g-12gb-ram-256gb' }, { $set: { active: false } });
  assert.ok(!slugs(await t.call('GET', `/products/${NOVA}/related`)).includes('voltix-nova-pro-5g-12gb-ram-256gb'));
  assert.equal((await t.call('GET', '/products/voltix-nova-pro-5g-12gb-ram-256gb/related')).status, 404);
  assert.equal((await t.call('GET', '/products/no-such-product/related')).status, 404);
  await products.updateOne({ slug: 'voltix-nova-pro-5g-12gb-ram-256gb' }, { $set: { active: true } });
});

test('recently viewed: cards in the order asked, hidden and unknown ones left out', async () => {
  const asked = ['the-quiet-engineer-paperback', 'no-such-product', NOVA, 'the-quiet-engineer-paperback'];
  const res = await t.call('GET', `/recently-viewed?slugs=${asked.join(',')}`);
  assert.equal(res.status, 200);
  assert.deepEqual(slugs(res), ['the-quiet-engineer-paperback', NOVA]);
  assert.equal(res.body.items[0].price, 34900);

  await t.db.collection('products').updateOne({ slug: NOVA }, { $set: { active: false } });
  assert.deepEqual(slugs(await t.call('GET', `/recently-viewed?slugs=${NOVA}`)), []);
  await t.db.collection('products').updateOne({ slug: NOVA }, { $set: { active: true } });

  assert.deepEqual((await t.call('GET', '/recently-viewed?slugs=')).body, { items: [] });
});

test('recently viewed refuses odd addresses and more than 10 products', async () => {
  assert.equal((await t.call('GET', '/recently-viewed')).status, 400);
  assert.equal((await t.call('GET', '/recently-viewed?slugs=a$b')).status, 400);
  const eleven = Array.from({ length: 11 }, (_, i) => `p-${i}`).join(',');
  assert.equal((await t.call('GET', `/recently-viewed?slugs=${eleven}`)).status, 400);
});
