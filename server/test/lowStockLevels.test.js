import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { lowStockProducts } from '../src/routes/dashboard.js';
import { lowStockEmail } from '../src/emails.js';

let t;
let admin;
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
});
after(() => t.stop());

const BOOK = 'the-quiet-engineer-paperback';
const SHOES = 'stride-running-shoes'; // UK 7–10 with 15/20/10/5, so UK 10 is low at the default 5
const product = (slug) => t.db.collection('products').findOne({ slug });
const setLevel = async (slug, lowStockAt) => {
  const p = await product(slug);
  return admin('PATCH', `/admin/products/${p._id}`, { lowStockAt });
};
const lowSlugs = async () => {
  const p = await admin('GET', '/admin/products?status=low&page=1');
  return p.body.items.map((i) => i.slug);
};

test("a product's own level decides when it is low, everywhere", async () => {
  await t.db.collection('products').updateOne({ slug: BOOK }, { $set: { stock: 8 } });
  assert.ok(!(await lowSlugs()).includes(BOOK));
  const before = (await admin('GET', '/admin/dashboard?days=7')).body.lowStockCount;

  const res = await setLevel(BOOK, 10);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.lowStockAt, 10);
  assert.ok((await lowSlugs()).includes(BOOK));
  assert.equal((await admin('GET', '/admin/dashboard?days=7')).body.lowStockCount, before + 1);
  const listed = (await lowStockProducts(t.db, 50)).find((p) => p.slug === BOOK);
  assert.equal(listed.lowAt, 10);
  assert.match(lowStockEmail([listed], 1).text, /: 8 left \(low at 10\)/);

  // Back to the default: 8 is more than 5.
  await setLevel(BOOK, null);
  assert.ok(!(await lowSlugs()).includes(BOOK));
});

test("options count against their product's level", async () => {
  assert.ok((await lowSlugs()).includes(SHOES)); // UK 10 has 5
  await setLevel(SHOES, 2);
  assert.ok(!(await lowSlugs()).includes(SHOES));
  await setLevel(SHOES, 12);
  const listed = (await lowStockProducts(t.db, 50)).find((p) => p.slug === SHOES);
  assert.deepEqual(
    listed.variants.map((v) => v.label),
    ['UK 9', 'UK 10'],
  );
  // 0: low only when sold out.
  await setLevel(SHOES, 0);
  assert.ok(!(await lowSlugs()).includes(SHOES));
});

test('the level is checked, logged and copied by Duplicate', async () => {
  await setLevel(BOOK, null);
  for (const bad of [-1, 1001, 2.5, '7']) assert.equal((await setLevel(BOOK, bad)).status, 400, String(bad));
  await setLevel(BOOK, 20);
  const log = await t.db
    .collection('activity')
    .find({ 'changes.field': 'Low-stock level' })
    .sort({ at: -1 })
    .limit(1)
    .toArray();
  assert.deepEqual(
    log[0].changes.find((c) => c.field === 'Low-stock level'),
    { field: 'Low-stock level', from: 'the default', to: '20' },
  );
  const book = await product(BOOK);
  const copy = await admin('POST', `/admin/products/${book._id}/duplicate`);
  assert.equal(copy.status, 201, JSON.stringify(copy.body));
  assert.equal(copy.body.lowStockAt, 20);
});
