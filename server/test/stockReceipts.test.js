import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { averageCost } from '../src/stockReceipts.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let packer;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  packer = await register('packer@example.com', 'Pooja Packer');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  await t.db.collection('users').updateOne({ email: 'packer@example.com' }, { $set: { role: 'packer' } });
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}

const BOOK = 'the-quiet-engineer-paperback';
const SHOES = 'stride-running-shoes';
const product = (slug) => t.db.collection('products').findOne({ slug });
const receive = (lines, extra = {}) =>
  admin('POST', '/admin/stock-receipts', { supplier: 'Mehta Traders', reference: 'INV-118', lines, ...extra });

test('the cost price is the average of the stock on hand and the delivery', () => {
  assert.equal(averageCost(10, 20000, 30, 22000), 21500);
  assert.equal(averageCost(10, null, 30, 22000), 22000); // no cost yet: the delivery's
  assert.equal(averageCost(0, 20000, 30, 22000), 22000); // nothing on the shelf: the delivery's
  assert.equal(averageCost(10, 20000, 30, null), 20000); // price not known: unchanged
});

test('a delivery adds stock, sets the cost price and is in the stock history', async () => {
  const book = await product(BOOK);
  const res = await receive([{ productId: book._id.toString(), qty: 10, unitCost: 22000 }], {
    note: 'Box slightly dented',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.number, 1);
  assert.deepEqual(res.body.lines[0], {
    productId: book._id.toString(),
    variantId: null,
    title: book.title,
    qty: 10,
    unitCost: 22000,
    stockBefore: book.stock,
    stockAfter: book.stock + 10,
    costBefore: null,
    costAfter: 22000,
  });
  assert.equal(res.body.value, 220000);
  const now = await product(BOOK);
  assert.deepEqual([now.stock, now.cost], [book.stock + 10, 22000]);

  const history = (await admin('GET', `/admin/products/${book._id}/stock-history`)).body.items[0];
  assert.deepEqual([history.reason, history.change, history.after], ['received', 10, book.stock + 10]);
  assert.deepEqual(history.receipt, { id: res.body.id, number: 1 });
  const logged = await t.db.collection('activity').findOne({ action: 'Received stock' });
  assert.equal(logged.target.label, 'Delivery #1 from Mehta Traders');
  assert.equal(logged.changes[0].to, '+10 at ₹220, cost now ₹220');

  // The next delivery at another price: the average of what's on the shelf and the new stock.
  const second = await receive([{ productId: book._id.toString(), qty: now.stock, unitCost: 20000 }]);
  assert.equal(second.body.number, 2);
  assert.equal(second.body.lines[0].costAfter, 21000);
  assert.equal((await product(BOOK)).cost, 21000);
});

test('options are received one by one; the product total follows', async () => {
  const shoes = await product(SHOES);
  const [s, m] = shoes.variants;
  const res = await receive([
    { productId: shoes._id.toString(), variantId: s._id.toString(), qty: 5, unitCost: 120000 },
    { productId: shoes._id.toString(), variantId: m._id.toString(), qty: 3 },
  ]);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const now = await product(SHOES);
  assert.equal(now.stock, shoes.stock + 8);
  assert.equal(now.variants[0].stock, s.stock + 5);
  assert.equal(now.variants[0].cost, 120000);
  assert.equal(now.variants[1].cost ?? null, m.cost ?? null); // no price given: unchanged
  assert.equal(res.body.value, null); // not every line has a price
  assert.equal(res.body.lines[1].title, `${shoes.title} (${m.label})`);
});

test('the cost price can be left alone', async () => {
  const book = await product(BOOK);
  const res = await receive([{ productId: book._id.toString(), qty: 2, unitCost: 99900 }], { updateCost: false });
  assert.equal(res.body.lines[0].costAfter, book.cost);
  assert.equal((await product(BOOK)).cost, book.cost);
});

test('a delivery with a bad line changes nothing, not even the numbering', async () => {
  const book = await product(BOOK);
  const shoes = await product(SHOES);
  const before = await t.db.collection('stockReceipts').countDocuments();
  for (const [lines, error] of [
    [
      [
        { productId: book._id.toString(), qty: 1 },
        { productId: shoes._id.toString(), qty: 1 },
      ],
      'Choose which size',
    ],
    [
      [
        { productId: book._id.toString(), qty: 1 },
        { productId: book._id.toString(), qty: 2 },
      ],
      'Each product',
    ],
    [[{ productId: shoes._id.toString(), variantId: '000000000000000000000000', qty: 1 }], 'no such option'],
    [[{ productId: '000000000000000000000000', qty: 1 }], 'no longer exists'],
    [[{ productId: book._id.toString(), qty: 0 }], 'At least 1'],
    [[], 'Add at least one product'],
  ]) {
    const res = await receive(lines);
    assert.equal(res.status, 400, JSON.stringify(lines));
    assert.ok(res.body.error.includes(error), `${res.body.error} / ${error}`);
  }
  assert.equal((await admin('POST', '/admin/stock-receipts', { lines: [] })).status, 400);
  assert.equal((await product(BOOK)).stock, book.stock);
  assert.equal(await t.db.collection('stockReceipts').countDocuments(), before);
  const next = await receive([{ productId: book._id.toString(), qty: 1 }]);
  assert.equal(next.body.number, before + 1);
});

test('deliveries are listed newest first, by supplier, with the names used before; admins only', async () => {
  const book = await product(BOOK);
  await receive([{ productId: book._id.toString(), qty: 1 }], { supplier: 'Pustak Distributors' });
  const all = (await admin('GET', '/admin/stock-receipts')).body;
  assert.equal(all.items[0].supplier, 'Pustak Distributors');
  assert.deepEqual(all.suppliers, ['Mehta Traders', 'Pustak Distributors']);
  const one = (await admin('GET', '/admin/stock-receipts?supplier=mehta%20traders')).body;
  assert.ok(one.items.length > 0 && one.items.every((r) => r.supplier === 'Mehta Traders'));
  assert.equal((await admin('GET', `/admin/stock-receipts/${all.items[0].id}`)).body.number, all.items[0].number);
  assert.equal((await packer('GET', '/admin/stock-receipts')).status, 403);
  assert.equal((await packer('POST', '/admin/stock-receipts', {})).status, 403);
});
