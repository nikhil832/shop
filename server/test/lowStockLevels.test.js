import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { lowStockProducts } from '../src/routes/dashboard.js';
import { lowStockEmail } from '../src/emails.js';
import { optionsOf } from '../src/variants.js';

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

// Stage 135: an option's own level.
const sendVariants = (doc, change) =>
  admin('PATCH', `/admin/products/${doc._id}`, {
    options: optionsOf(doc),
    variants: doc.variants.map((v) => ({
      id: v._id.toString(),
      values: v.values,
      price: v.price,
      mrp: v.mrp,
      stock: v.stock,
      images: v.images ?? [],
      ...change(v),
    })),
  });

test('an option can have its own level, kept when a save leaves it out', async () => {
  await setLevel(SHOES, 2); // the product's: nothing low (UK 10 has 5)
  assert.ok(!(await lowSlugs()).includes(SHOES));
  const shoes = await product(SHOES);
  const res = await sendVariants(shoes, (v) => (v.label === 'UK 7' ? { lowStockAt: 20 } : {}));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(
    res.body.variants.map((v) => v.lowStockAt),
    [20, null, null, null],
  );
  assert.ok((await lowSlugs()).includes(SHOES)); // UK 7 has 15, its level 20
  const listed = (await lowStockProducts(t.db, 50)).find((p) => p.slug === SHOES);
  assert.deepEqual(listed.variants, [{ label: 'UK 7', stock: 15, lowAt: 20 }]);
  assert.match(lowStockEmail([listed], 1).text, /UK 7: 15 left \(low at 20\)/);

  // A save without the field (an older form, a stock change) keeps it.
  await sendVariants(await product(SHOES), () => ({}));
  assert.equal((await product(SHOES)).variants[0].lowStockAt, 20);
  const log = await t.db
    .collection('activity')
    .findOne({ 'changes.field': 'UK 7: low-stock level' }, { sort: { at: -1 } });
  assert.deepEqual(
    log.changes.find((c) => c.field === 'UK 7: low-stock level'),
    { field: 'UK 7: low-stock level', from: "the product's", to: '20' },
  );

  // Checked like the product's; null goes back to the product's level.
  for (const bad of [-1, 1001, 2.5])
    assert.equal((await sendVariants(shoes, () => ({ lowStockAt: bad }))).status, 400, String(bad));
  await sendVariants(await product(SHOES), () => ({ lowStockAt: null }));
  assert.ok(!(await lowSlugs()).includes(SHOES));
  await setLevel(SHOES, null);
});
