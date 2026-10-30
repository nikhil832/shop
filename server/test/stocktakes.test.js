import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'Store Admin');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  customer = await register('asha@example.com', 'Asha Rao');
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name, email, password: 'password123' });
  assert.equal(res.status, 201);
  return call;
}

const BOOK = 'the-quiet-engineer-paperback';
const SHOES = 'stride-running-shoes';
const product = (slug) => t.db.collection('products').findOne({ slug });
const category = (slug) => t.db.collection('categories').findOne({ slug });
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
async function order(slug, qty) {
  const p = await product(slug);
  const quote = await customer('GET', `/cart?items=${p._id}:${qty}`);
  const res = await customer('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty }],
    address,
    expectedTotal: quote.body.total,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
const sheetRow = (sheet, productId, variantId = null) =>
  sheet.rows.find((r) => r.productId === productId && r.variantId === variantId);

test('only admins count stock', async () => {
  assert.equal((await t.call('GET', '/admin/stocktakes/sheet')).status, 401);
  assert.equal((await customer('GET', '/admin/stocktakes/sheet')).status, 403);
  assert.equal((await customer('POST', '/admin/stocktakes', { lines: [] })).status, 403);
});

test('the sheet counts sold-but-unshipped units as still on the shelf', async () => {
  const books = await category('books');
  const book = await product(BOOK);
  const placed = await order(BOOK, 2);
  const sheet = (await admin('GET', `/admin/stocktakes/sheet?category=${books._id}`)).body;
  assert.equal(sheet.category.name, 'Books');
  assert.ok(sheet.rows.every((r) => r.variantId === null));
  const row = sheetRow(sheet, book._id.toString());
  assert.equal(row.stock, book.stock - 2);
  assert.equal(row.reserved, 2);
  assert.equal(row.onShelf, book.stock);

  // Once shipped, it has left the shelf.
  assert.equal((await admin('POST', `/admin/orders/${placed.id}/status`, { status: 'shipped' })).status, 200);
  const after = sheetRow((await admin('GET', `/admin/stocktakes/sheet?category=${books._id}`)).body, row.productId);
  assert.equal(after.reserved, 0);
  assert.equal(after.onShelf, book.stock - 2);

  // Products with options are counted per option; the whole store without a category.
  const shoes = await product(SHOES);
  const all = (await admin('GET', '/admin/stocktakes/sheet')).body;
  assert.equal(all.category, null);
  assert.equal(all.rows.filter((r) => r.productId === shoes._id.toString()).length, shoes.variants.length);
  assert.equal(sheetRow(all, shoes._id.toString()), undefined);
  assert.equal((await admin('GET', '/admin/stocktakes/sheet?category=nope')).status, 400);
});

test('a count is previewed, then saved: stock put right, history, log; uncounted rows untouched', async () => {
  const book = await product(BOOK);
  const shoes = await product(SHOES);
  const size = shoes.variants[0];
  await order(BOOK, 1); // one more on the shelf, waiting to ship
  const sheet = (await admin('GET', '/admin/stocktakes/sheet')).body;
  const bookRow = sheetRow(sheet, book._id.toString());
  const sizeRow = sheetRow(sheet, shoes._id.toString(), size._id.toString());
  const lines = [
    { productId: bookRow.productId, counted: bookRow.onShelf - 3 }, // three missing
    { productId: sizeRow.productId, variantId: sizeRow.variantId, counted: sizeRow.onShelf + 2 }, // two found
  ];

  const preview = (await admin('POST', '/admin/stocktakes', { lines, preview: true })).body.preview;
  assert.equal(preview.changed, 2);
  assert.equal(preview.difference, -1);
  assert.equal(preview.rows[0].stockAfter, bookRow.stock - 3);
  assert.equal(preview.rows[1].stockAfter, sizeRow.stock + 2);
  assert.equal((await product(BOOK)).stock, bookRow.stock); // nothing saved

  const res = await admin('POST', '/admin/stocktakes', { lines, note: 'Shelf B' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.number, 1);
  assert.equal(res.body.changed, 2);
  assert.equal(res.body.difference, -1);
  assert.equal(res.body.lines[0].difference, -3);
  assert.equal(res.body.lines[1].title, `Stride Running Shoes (${size.label})`);
  assert.equal((await product(BOOK)).stock, bookRow.stock - 3);
  const shoesAfter = await product(SHOES);
  assert.equal(shoesAfter.variants[0].stock, size.stock + 2);
  assert.equal(shoesAfter.stock, shoes.stock + 2); // the product's total moves with its option
  assert.equal(shoesAfter.variants[1].stock, shoes.variants[1].stock); // not counted

  const history = await admin('GET', `/admin/products/${book._id}/stock-history`);
  const entry = history.body.items[0];
  assert.equal(entry.reason, 'counted');
  assert.equal(entry.change, -3);
  assert.deepEqual(entry.stocktake, { id: res.body.id, number: 1 });
  const log = await t.db.collection('activity').findOne({ action: 'Counted stock' });
  assert.equal(log.target.label, 'Stocktake #1');
  assert.equal(log.changes.length, 2);

  assert.equal((await admin('GET', `/admin/stocktakes/${res.body.id}`)).body.note, 'Shelf B');
  const list = (await admin('GET', '/admin/stocktakes')).body;
  assert.equal(list.total, 1);
  assert.equal(list.items[0].counted, 2);
});

test('a count below the waiting orders leaves no stock and says how short it is', async () => {
  const book = await product(BOOK);
  const row = sheetRow((await admin('GET', '/admin/stocktakes/sheet')).body, book._id.toString());
  assert.ok(row.reserved >= 1);
  const res = await admin('POST', '/admin/stocktakes', { lines: [{ productId: row.productId, counted: 0 }] });
  assert.equal(res.body.lines[0].stockAfter, 0);
  assert.equal(res.body.lines[0].short, row.reserved);
  assert.equal((await product(BOOK)).stock, 0);
});

test('bad counts are refused whole', async () => {
  const shoes = await product(SHOES);
  const book = await product(BOOK);
  const send = (lines) => admin('POST', '/admin/stocktakes', { lines });
  assert.equal((await send([])).status, 400);
  assert.equal((await send([{ productId: book._id.toString(), counted: -1 }])).status, 400);
  assert.equal((await send([{ productId: book._id.toString(), counted: 1.5 }])).status, 400);
  assert.equal(
    (
      await send([
        { productId: book._id.toString(), counted: 1 },
        { productId: book._id.toString(), counted: 2 },
      ])
    ).status,
    400,
  );
  const byOptions = await send([{ productId: shoes._id.toString(), counted: 4 }]);
  assert.equal(byOptions.status, 400);
  assert.match(byOptions.body.error, /by its options/);
  const noOption = await send([{ productId: shoes._id.toString(), variantId: book._id.toString(), counted: 4 }]);
  assert.match(noOption.body.error, /no such option/);
  const stock = (await product(SHOES)).stock;
  const mixed = await send([
    { productId: shoes._id.toString(), variantId: shoes.variants[0]._id.toString(), counted: 99 },
    { productId: '0123456789abcdef01234567', counted: 1 },
  ]);
  assert.equal(mixed.status, 400);
  assert.equal((await product(SHOES)).stock, stock); // nothing saved
});
