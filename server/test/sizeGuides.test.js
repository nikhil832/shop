import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseTable } from '../src/sizeGuides.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
let fashion;
let shoes;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  customer = await register('customer@example.com');
  fashion = await t.db.collection('categories').findOne({ slug: 'fashion' });
  shoes = await t.db.collection('products').findOne({ slug: 'stride-running-shoes' });
});
after(() => t.stop());

async function register(email) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name: 'Someone', email, password: 'password123' })).status, 201);
  return call;
}

const SHOE_TABLE = 'UK, EU, Foot length (cm)\n7, 41, 25.4\n8, 42, 26.0\n\n9, 43, 26.7\n';
const guideOf = async (slug) => (await t.call('GET', `/products/${slug}/size-guide`)).body.guide;

test('tables are typed one row per line, with commas (or tabs from a spreadsheet)', () => {
  assert.deepEqual(parseTable(SHOE_TABLE), {
    columns: ['UK', 'EU', 'Foot length (cm)'],
    rows: [
      ['7', '41', '25.4'],
      ['8', '42', '26.0'],
      ['9', '43', '26.7'],
    ],
  });
  assert.deepEqual(parseTable('Size\tChest\nS\t36').rows, [['S', '36']]);
  assert.throws(() => parseTable('UK, EU\n7'), /Row 1 has 1 cells; the headings have 2/);
  assert.throws(() => parseTable('UK, EU'), /at least one row/);
  assert.throws(() => parseTable(`${'a,'.repeat(8)}a\n${'1,'.repeat(8)}1`), /At most 8 columns/);
});

test("a category's guide shows on its products; a product can choose another or none", async () => {
  assert.equal(await guideOf(shoes.slug), null);
  const res = await admin('POST', '/admin/size-guides', {
    name: 'Shoes',
    table: SHOE_TABLE,
    note: 'Measure your foot from heel to toe.',
    categoryIds: [fashion._id.toString()],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const shown = await guideOf(shoes.slug);
  assert.deepEqual(
    [shown.name, shown.columns.length, shown.rows.length, shown.note],
    ['Shoes', 3, 3, 'Measure your foot from heel to toe.'],
  );

  const kurta = await admin('POST', '/admin/size-guides', { name: 'Kurtas', table: 'Size, Chest (in)\nS, 36\nM, 38' });
  assert.equal(kurta.status, 201);
  const kurtaProduct = await t.db.collection('products').findOne({ slug: 'urbane-women-kurta-set' });
  assert.equal(
    (await admin('PATCH', `/admin/products/${kurtaProduct._id}`, { sizeGuide: kurta.body.id })).body.sizeGuide,
    kurta.body.id,
  );
  assert.equal((await guideOf('urbane-women-kurta-set')).name, 'Kurtas');
  await admin('PATCH', `/admin/products/${shoes._id}`, { sizeGuide: 'none' });
  assert.equal(await guideOf(shoes.slug), null);
  await admin('PATCH', `/admin/products/${shoes._id}`, { sizeGuide: null });
  assert.equal((await guideOf(shoes.slug)).name, 'Shoes');

  // Deleting a guide sends its products back to their category's.
  assert.equal((await admin('DELETE', `/admin/size-guides/${kurta.body.id}`)).status, 204);
  assert.equal((await guideOf('urbane-women-kurta-set')).name, 'Shoes');
  assert.ok(await t.db.collection('activity').findOne({ action: 'Deleted size guide' }));
});

test('a category has one guide: giving it to another takes it from the first', async () => {
  const [first] = (await admin('GET', '/admin/size-guides')).body.items;
  const second = await admin('POST', '/admin/size-guides', {
    name: 'Everything fashion',
    table: 'Size, Waist\n30, 30',
    categoryIds: [fashion._id.toString()],
  });
  assert.equal(second.status, 201);
  const items = (await admin('GET', '/admin/size-guides')).body.items;
  assert.deepEqual(items.find((g) => g.id === first.id).categoryIds, []);
  assert.equal((await guideOf(shoes.slug)).name, 'Everything fashion');
  const edited = await admin('PUT', `/admin/size-guides/${first.id}`, {
    name: 'Shoes',
    table: SHOE_TABLE,
    categoryIds: [fashion._id.toString()],
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal((await guideOf(shoes.slug)).name, 'Shoes');
});

test('checked, and admins only to change', async () => {
  const bad = await admin('POST', '/admin/size-guides', { name: 'Odd', table: 'A, B\n1' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Row 1 has 1 cells/);
  assert.equal((await admin('PATCH', `/admin/products/${shoes._id}`, { sizeGuide: 'nope' })).status, 400);
  assert.equal((await customer('POST', '/admin/size-guides', { name: 'X', table: 'A\n1' })).status, 403);
  assert.equal((await t.call('GET', '/products/no-such-product/size-guide')).status, 404);
});
