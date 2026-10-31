import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { parseCsv } from '../src/routes/productImport.js';

let t;
let admin;
let customer;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  customer = await register('customer@example.com');
});
after(() => t.stop());

async function register(email) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name: 'Someone', email, password: 'password123' })).status, 201);
  return call;
}

const csv = (text) => Buffer.from(text);
const check = (text, who = admin) => who('POST', '/admin/products/import', csv(text), 'text/csv');
const save = (text, plan) => admin('POST', `/admin/products/import/save?plan=${plan}`, csv(text), 'text/csv');
const product = (slug) => t.db.collection('products').findOne({ slug });
const BOOK = 'the-quiet-engineer-paperback';
const SHOES = 'stride-running-shoes';

test('reads CSV: quotes, commas, doubled quotes, line breaks, CRLF, a BOM, and semicolons from Excel', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"x, y","say ""hi""\nthere"\r\n'), [
    ['a', 'b'],
    ['x, y', 'say "hi"\nthere'],
  ]);
  assert.deepEqual(parseCsv('a;b\n1,5;2'), [
    ['a', 'b'],
    ['1,5', '2'],
  ]);
  assert.deepEqual(parseCsv('a,b'), [['a', 'b']]);
});

test('only admins import and export', async () => {
  assert.equal((await t.call('GET', '/admin/products/export')).status, 401);
  assert.equal((await customer('GET', '/admin/products/export')).status, 403);
  assert.equal((await check('Slug\nx', t.call)).status, 401);
  assert.equal((await check('Slug\nx', customer)).status, 403);
  assert.equal(
    (await customer('POST', '/admin/products/import/save?plan=' + 'a'.repeat(32), csv('x'), 'text/csv')).status,
    403,
  );
});

test('the export lists every product, then a row per variant; re-importing it changes nothing', async () => {
  const res = await admin('GET', '/admin/products/export');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="products-\d{4}-\d\d-\d\d\.csv"/);
  const text = res.body.toString('utf8');
  assert.ok(
    text.startsWith(
      '\uFEFFSlug,Variant,Title,Brand,Category,Price (₹),MRP (₹),Cost (₹),Stock,Shown,Highlights,Description,Specifications,SKU,Barcode\r\n',
    ),
  );
  const rows = parseCsv(text);
  const variantRows = (
    await t.db
      .collection('products')
      .find({ 'variants.0': { $exists: true } })
      .toArray()
  ).reduce((n, p) => n + p.variants.length, 0);
  assert.equal(rows.length, 1 + 38 + variantRows);
  const book = rows.find((r) => r[0] === BOOK && !r[1]);
  assert.deepEqual(book.slice(0, 10), [
    BOOK,
    '',
    'The Quiet Engineer (Paperback)',
    'Pustak Press',
    'Books',
    '349.00',
    '499.00',
    '', // no cost price yet
    book[8],
    'yes',
  ]);
  // A product with sizes has its numbers on its variant rows.
  const shoes = rows.filter((r) => r[0] === SHOES);
  assert.equal(shoes[0][5], '');
  assert.ok(shoes.slice(1).every((r) => r[1] && r[5]));

  const preview = await check(text);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.summary, { new: 0, update: 0, same: rows.length - 1, error: 0 });
  assert.equal((await save(text, preview.body.plan)).status, 400); // nothing to change
});

test('the preview shows each change and saves nothing; saving applies all of them', async () => {
  const file = [
    'Slug,Variant,Title,Brand,Category,Price (₹),MRP (₹),Stock,Shown,Highlights,Description,Notes',
    `${BOOK},,,,,"1,299.50",1499,7,,Short | Clear,,mine`,
    `${SHOES},UK 9,,,,,,0,,,,`,
    ',,Clay Mug,Mitti,Home & Kitchen,299,399,12,no,Handmade | 350 ml,A mug.,',
    ',,Clay Mug,Mitti,home-kitchen,299,399,3,,,,',
  ].join('\n');
  const before = await product(BOOK);
  const res = await check(file);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.summary, { new: 2, update: 2, same: 0, error: 0 });
  assert.deepEqual(res.body.ignored, ['Notes']);
  const [book, shoes, mug] = res.body.rows;
  assert.equal(book.row, 2);
  assert.equal(book.title, 'The Quiet Engineer (Paperback)');
  assert.deepEqual(
    book.changes.map((c) => c.field),
    ['highlights', 'price', 'mrp', 'stock'],
  );
  assert.deepEqual(book.changes[1], { field: 'price', from: 34900, to: 129950 });
  assert.equal(shoes.variant, 'UK 9');
  assert.deepEqual(
    shoes.changes.map((c) => [c.field, c.to]),
    [['stock', 0]],
  );
  assert.equal(mug.action, 'new');
  assert.deepEqual(await product(BOOK), before); // nothing saved yet

  const saved = await save(file, res.body.plan);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { added: 2, updated: 2 });
  const book2 = await product(BOOK);
  assert.deepEqual([book2.price, book2.mrp, book2.stock, book2.highlights], [129950, 149900, 7, ['Short', 'Clear']]);
  assert.ok(book2.updatedAt > before.updatedAt);
  // Variant stock and the product's total move together.
  const shoes2 = await product(SHOES);
  assert.equal(shoes2.variants.find((v) => v.label === 'UK 9').stock, 0);
  assert.equal(
    shoes2.stock,
    shoes2.variants.reduce((n, v) => n + v.stock, 0),
  );
  // Two new products with one title get two slugs; the first is hidden, with a placeholder photo and no rating.
  const mugs = await t.db.collection('products').find({ title: 'Clay Mug' }).sort({ slug: 1 }).toArray();
  assert.deepEqual(
    mugs.map((m) => m.slug),
    ['clay-mug', 'clay-mug-2'],
  );
  assert.equal(mugs[0].active, false);
  assert.equal(mugs[1].active, true);
  assert.deepEqual(mugs[0].highlights, ['Handmade', '350 ml']);
  assert.match(mugs[0].images[0], /^data:image\/svg\+xml,/);
  assert.deepEqual(mugs[0].rating, { avg: 0, count: 0 });
  assert.equal((await t.call('GET', '/products/clay-mug-2')).body.price, 29900);
});

test('rows with problems are named, and then nothing can be saved', async () => {
  const file = [
    'slug,variant,title,brand,category,price,mrp,stock,shown',
    `${BOOK},,,,,500,400,,`, // MRP below price
    'no-such-product,,,,,,,1,',
    `${SHOES},UK 99,,,,,,1,`,
    `${SHOES},,,,,999,,,`, // product price on a product with sizes
    `${BOOK},,,,,,,abc,`,
    ',,Lamp,Glow,Lighting,100,100,1,', // unknown category
    ',,Lamp,,,100,100,1,', // missing brand and category
    `${BOOK},,,,,,,,maybe`,
    `${SHOES},uk 8,,,,,,1,`,
    `${SHOES},UK 8,,,,,,2,`, // the same variant twice
    `,UK 8,,,,,,2,`,
  ].join('\n');
  const res = await check(file);
  assert.equal(res.status, 200);
  const errors = res.body.rows.map((r) => r.error ?? null);
  assert.deepEqual(errors, [
    'MRP must be at least the price',
    'No product with the slug "no-such-product"',
    '"Stride Running Shoes" has no variant "UK 99"',
    'This product has sizes or colours: change the price and stock on its variant rows',
    'Stock must be a whole number from 0 to 100000',
    'No category "Lighting": use one from Admin → Categories',
    'A new product needs brand, category',
    'Listed twice: see row 2',
    null,
    'Listed twice: see row 10',
    "Give the product's slug for a variant row",
  ]);
  const saved = await save(file, res.body.plan);
  assert.equal(saved.status, 400);
  assert.equal(saved.body.error, 'Fix the rows with problems first');

  const bad = await check(`slug,stock\n${BOOK},abc`);
  assert.equal(bad.body.rows[0].error, 'Stock must be a whole number from 0 to 100000');
  assert.equal(
    (await check(`slug,price\n${BOOK},12.345`)).body.rows[0].error,
    'Price must be an amount in rupees, like 1499 or 1499.50',
  );
  assert.equal((await check(`slug,shown\n${BOOK},maybe`)).body.rows[0].error, 'Shown must be yes or no');
  assert.equal(
    (await check(`slug,variant,stock\n${BOOK},Red,1`)).body.rows[0].error,
    '"The Quiet Engineer (Paperback)" has no sizes or colours: leave Variant empty',
  );
});

test('a file the store has changed under since the preview is refused', async () => {
  const file = `slug,stock\n${BOOK},20`;
  const res = await check(file);
  await t.db.collection('products').updateOne({ slug: BOOK }, { $inc: { stock: -1 } }); // an order meanwhile
  const saved = await save(file, res.body.plan);
  assert.equal(saved.status, 409);
  assert.match(saved.body.error, /changed since you checked/);
  assert.notEqual((await product(BOOK)).stock, 20);
  const again = await check(file);
  assert.equal((await save(file, again.body.plan)).status, 200);
  assert.equal((await product(BOOK)).stock, 20);
});

test('odd files: no headings, no rows, too many rows, too large, no plan', async () => {
  assert.match((await check('hello,world\n1,2')).body.error, /column headings/);
  assert.match((await check('Slug,Title\n\n,\n')).body.error, /no product rows/);
  const many = `slug,stock\n${Array.from({ length: 1001 }, () => `${BOOK},1`).join('\n')}`;
  assert.match((await check(many)).body.error, /At most 1000 rows/);
  const huge = await check(`slug,description\n${BOOK},${'x'.repeat(1_100_000)}`);
  assert.equal(huge.status, 413);
  assert.equal((await admin('POST', '/admin/products/import', csv(' '), 'text/csv')).status, 400);
  assert.equal(
    (await admin('POST', '/admin/products/import/save', csv(`slug,stock\n${BOOK},1`), 'text/csv')).status,
    400,
  );
});

test('text that a spreadsheet would run as a formula is escaped on export and read back as typed', async () => {
  await t.db.collection('products').updateOne({ slug: BOOK }, { $set: { brand: '=Pustak' } });
  const text = (await admin('GET', '/admin/products/export')).body.toString('utf8');
  assert.ok(text.includes(",'=Pustak,"));
  const res = await check(text);
  assert.equal(res.body.summary.update, 0);
  assert.equal(res.body.summary.error, 0);
});
