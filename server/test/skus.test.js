import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { validGtin } from '../src/skus.js';
import { parseCsv } from '../src/routes/productImport.js';
import { productJsonLd } from '../src/preview.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
let book;
let novel;
let shoes;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  customer = await register('customer@example.com', 'Asha Rao');
  book = await products().findOne({ slug: 'the-quiet-engineer-paperback' });
  novel = await products().findOne({ slug: 'monsoon-stories-hardcover' });
  shoes = await products().findOne({ slug: 'stride-running-shoes' });
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}

const products = () => t.db.collection('products');
const EAN = '4006381333931'; // a valid EAN-13
const UPC = '036000291452'; // a valid UPC-A
const variantsOf = (doc, codes = {}) =>
  doc.variants.map((v) => ({
    id: v._id.toString(),
    label: v.label,
    price: v.price,
    mrp: v.mrp,
    stock: v.stock,
    ...codes[v.label],
  }));

test('barcodes are checked with their check digit', () => {
  for (const code of [EAN, UPC, '73513537', '10012345678902']) assert.equal(validGtin(code), true, code);
  for (const code of ['4006381333932', '12345', '400638133393', 'abcdefgh']) assert.equal(validGtin(code), false, code);
});

test('a product and its options get an SKU and a barcode; SKUs are kept in capitals', async () => {
  let res = await admin('PATCH', `/admin/products/${book._id}`, { sku: ' bk-quiet-01 ', barcode: '4006 3813 33931' });
  assert.equal(res.status, 200);
  assert.equal(res.body.sku, 'BK-QUIET-01');
  assert.equal(res.body.barcode, EAN);

  res = await admin('PATCH', `/admin/products/${shoes._id}`, {
    options: ['Size'],
    variants: variantsOf(shoes, { 'UK 7': { sku: 'STR-RUN-7', barcode: UPC }, 'UK 8': { sku: 'STR-RUN-8' } }),
  });
  assert.equal(res.status, 200);
  const codes = Object.fromEntries(res.body.variants.map((v) => [v.label, [v.sku, v.barcode]]));
  assert.deepEqual(codes['UK 7'], ['STR-RUN-7', UPC]);
  assert.deepEqual(codes['UK 8'], ['STR-RUN-8', null]);
  // A save that doesn't send an option's codes keeps them.
  res = await admin('PATCH', `/admin/products/${shoes._id}`, {
    options: ['Size'],
    variants: variantsOf(await products().findOne({ _id: shoes._id })), // sends no codes
  });
  assert.equal(res.body.variants.find((v) => v.label === 'UK 7').sku, 'STR-RUN-7');

  const entry = await t.db.collection('activity').findOne({ 'changes.field': 'SKU' });
  assert.deepEqual(
    entry.changes.find((c) => c.field === 'SKU'),
    { field: 'SKU', from: '(none)', to: 'BK-QUIET-01' },
  );
  assert.ok(await t.db.collection('activity').findOne({ 'changes.field': 'UK 7: SKU' }));
  // Not in the shop's product response.
  const page = (await t.call('GET', `/products/${book.slug}`)).body;
  assert.equal(page.sku, undefined);
  assert.equal(page.barcode, undefined);
});

test('codes are unique across products and options, and checked for shape', async () => {
  for (const [body, status, message] of [
    [{ sku: 'BK-QUIET-01' }, 409, /SKU BK-QUIET-01 is already used by The Quiet Engineer/],
    [{ sku: 'str-run-7' }, 409, /already used by Stride Running Shoes \(UK 7\)/],
    [{ barcode: UPC }, 409, /Barcode 036000291452 is already used by Stride Running Shoes \(UK 7\)/],
    [{ barcode: '4006381333932' }, 400, /8, 12, 13 or 14 digits/],
    [{ sku: 'has space' }, 400, /letters, digits and/],
    [{ sku: 'x'.repeat(41) }, 400, /at most 40/],
  ]) {
    const res = await admin('PATCH', `/admin/products/${novel._id}`, body);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.match(res.body.error, message);
  }
  // Two options of one product can't share one either.
  const res = await admin('PATCH', `/admin/products/${shoes._id}`, {
    options: ['Size'],
    variants: variantsOf(shoes, { 'UK 9': { sku: 'STR-RUN-7' } }),
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /SKU STR-RUN-7 is given twice/);
  // A product keeps its own code when saved again, and can drop it.
  assert.equal((await admin('PATCH', `/admin/products/${book._id}`, { sku: 'BK-QUIET-01' })).status, 200);
  assert.equal((await customer('PATCH', `/admin/products/${novel._id}`, { sku: 'NEW' })).status, 403);
});

test('the admin search finds products by SKU and by a scanned barcode', async () => {
  const titles = async (q) =>
    (await admin('GET', `/admin/products?q=${encodeURIComponent(q)}`)).body.items.map((p) => p.title);
  assert.deepEqual(await titles('bk-quiet'), [book.title]);
  assert.deepEqual(await titles(EAN), [book.title]);
  assert.deepEqual(await titles(UPC), [shoes.title]);
  assert.deepEqual(await titles('STR-RUN-8'), [shoes.title]);
});

test('orders keep the SKU sold; only admins see it; slips and the stocktake sheet have it', async () => {
  const uk7 = shoes.variants.find((v) => v.label === 'UK 7');
  const items = [
    { productId: book._id.toString(), qty: 1 },
    { productId: shoes._id.toString(), variantId: uk7._id.toString(), qty: 1 },
  ];
  const quote = await customer('GET', `/cart?items=${book._id}:1,${shoes._id}.${uk7._id}:1`);
  const placed = await customer('POST', '/orders', {
    items,
    address: {
      name: 'Asha Rao',
      phone: '9876543210',
      line1: '12 MG Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
    },
    expectedTotal: quote.body.total,
  });
  assert.equal(placed.status, 201);
  assert.deepEqual(
    placed.body.items.map((i) => i.sku),
    [undefined, undefined],
  );
  const asAdmin = (await admin('GET', `/admin/orders/${placed.body.id}`)).body;
  assert.deepEqual(
    asAdmin.items.map((i) => i.sku),
    ['BK-QUIET-01', 'STR-RUN-7'],
  );
  // Changing the SKU later doesn't change what the order says was sold.
  await admin('PATCH', `/admin/products/${book._id}`, { sku: 'BK-QUIET-02' });
  assert.equal((await admin('GET', `/admin/orders/${placed.body.id}`)).body.items[0].sku, 'BK-QUIET-01');

  const sheet = (await admin('GET', '/admin/stocktakes/sheet')).body.rows;
  assert.equal(sheet.find((r) => r.productId === book._id.toString()).sku, 'BK-QUIET-02');
  assert.equal(sheet.find((r) => r.variantId === uk7._id.toString()).sku, 'STR-RUN-7');
});

test('a copy starts without codes, and search engines get the barcode', async () => {
  const copy = (await admin('POST', `/admin/products/${shoes._id}/duplicate`)).body;
  assert.ok(copy.variants.every((v) => v.sku === null && v.barcode === null));
  const bookCopy = (await admin('POST', `/admin/products/${book._id}/duplicate`)).body;
  assert.equal(bookCopy.sku, null);
  assert.equal(productJsonLd(await products().findOne({ _id: book._id }), 'https://shop.example').gtin, EAN);
  assert.equal(productJsonLd(await products().findOne({ _id: shoes._id }), 'https://shop.example').gtin, undefined);
});

test('the spreadsheet has SKU and Barcode columns, and refuses a code used twice', async () => {
  const csv = (await admin('GET', '/admin/products/export')).body.toString('utf8');
  const rows = parseCsv(csv);
  const [sku, barcode] = [rows[0].indexOf('SKU'), rows[0].indexOf('Barcode')];
  assert.deepEqual([sku, barcode], [rows[0].length - 2, rows[0].length - 1]);
  const bookRow = rows.find((r) => r[0] === book.slug && !r[1]);
  assert.deepEqual([bookRow[sku], bookRow[barcode]], ['BK-QUIET-02', EAN]);
  assert.equal(rows.find((r) => r[0] === shoes.slug && r[1] === 'UK 7')[sku], 'STR-RUN-7');

  const head = rows[0].join(',');
  const cells = (slug, variant, code, bar = '') => {
    const row = Array(rows[0].length).fill('');
    row[0] = slug;
    row[1] = variant;
    row[sku] = code;
    row[barcode] = bar;
    return row.join(',');
  };
  const upload = (...lines) =>
    admin('POST', '/admin/products/import', Buffer.from([head, ...lines, ''].join('\r\n')), 'text/csv');

  let res = await upload(cells(novel.slug, '', 'nov-01', '73513537'), cells(shoes.slug, 'UK 9', 'STR-RUN-9'));
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.rows.map((r) => r.action),
    ['update', 'update'],
  );
  assert.deepEqual(res.body.rows[0].changes, [
    { field: 'sku', from: '', to: 'NOV-01' },
    { field: 'barcode', from: '', to: '73513537' },
  ]);

  // Used by another product in the store, or twice in the file.
  res = await upload(cells(novel.slug, '', 'STR-RUN-7'));
  assert.equal(res.body.rows[0].action, 'error');
  assert.match(res.body.rows[0].error, /SKU STR-RUN-7 is also used by Stride Running Shoes \(UK 7\)/);
  res = await upload(cells(novel.slug, '', 'SAME-1'), cells(shoes.slug, 'UK 10', 'same-1'));
  assert.deepEqual(
    res.body.rows.map((r) => r.action),
    ['error', 'error'],
  );
  // Moving a code from one product to another in the same file is fine.
  res = await upload(cells(book.slug, '', 'BK-NEW'), cells(novel.slug, '', 'BK-QUIET-02'));
  assert.deepEqual(
    res.body.rows.map((r) => r.action),
    ['update', 'update'],
  );
  res = await upload(cells(novel.slug, '', '', '4006381333932'));
  assert.match(res.body.rows[0].error, /8, 12, 13 or 14 digits/);
});
