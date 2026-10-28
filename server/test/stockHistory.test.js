import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { expireUnpaidOrders } from '../src/routes/orders.js';
import { savedEntries } from '../src/stockHistory.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let packer;
let support;
let customer;
before(async () => {
  t = await startTestServer({ razorpay: true });
  admin = await register('owner@example.com', 'Store Owner');
  packer = await register('packer@example.com', 'Pooja Packer');
  support = await register('support@example.com', 'Sam Support');
  customer = await register('customer@example.com', 'Asha Rao');
  const users = t.db.collection('users');
  await users.updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  await users.updateOne({ email: 'packer@example.com' }, { $set: { role: 'packer' } });
  await users.updateOne({ email: 'support@example.com' }, { $set: { role: 'support' } });
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}

const BOOK = 'the-quiet-engineer-paperback'; // ₹349, no variants
const SHOES = 'stride-running-shoes'; // sizes
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
const product = (slug) => t.db.collection('products').findOne({ slug });
const history = async (doc, query = '', who = admin) => {
  const res = await who('GET', `/admin/products/${doc._id}/stock-history${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};
// The entries as [reason, label, change, after, by], newest first.
const rows = (body) => body.items.map((e) => [e.reason, e.label, e.change, e.after, e.by]);

async function order(call, lines, { online = false } = {}) {
  const items = lines.map(([doc, qty, variantId]) => ({
    productId: doc._id.toString(),
    ...(variantId && { variantId: variantId.toString() }),
    qty,
  }));
  const quote = await call(
    'GET',
    `/cart?items=${items.map((i) => `${i.productId}${i.variantId ? `.${i.variantId}` : ''}:${i.qty}`).join(',')}`,
  );
  const res = await call('POST', '/orders', {
    items,
    address,
    expectedTotal: quote.body.total,
    paymentMethod: online ? 'razorpay' : 'cod',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('orders take stock and cancellations give it back, each recorded with the order and the stock after', async () => {
  const book = await product(BOOK);
  const start = book.stock;
  const first = await order(customer, [[book, 2]]);
  const second = await order(customer, [[book, 1]]);
  assert.equal((await customer('POST', `/orders/${first.id}/cancel`)).status, 200);
  assert.equal((await admin('POST', `/admin/orders/${second.id}/status`, { status: 'cancelled' })).status, 200);

  const body = await history(book);
  assert.deepEqual(rows(body), [
    ['store_cancelled', null, 1, start, 'Store Owner'],
    ['cancelled', null, 2, start - 1, null],
    ['ordered', null, -1, start - 3, null],
    ['ordered', null, -2, start - 2, null],
  ]);
  assert.deepEqual(body.items[0].order, { id: second.id, number: second.number });
  assert.equal(body.product.stock, start);
  assert.equal((await product(BOOK)).stock, start);
});

test('an unpaid online order released after its payment window is recorded as such', async () => {
  const book = await product(BOOK);
  const placed = await order(customer, [[book, 1]], { online: true });
  await t.db
    .collection('orders')
    .updateOne({ number: placed.number }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  await expireUnpaidOrders(t.ctx);
  const [released, ordered] = rows(await history(book));
  assert.deepEqual(released, ['released', null, 1, book.stock, null]);
  assert.deepEqual(ordered, ['ordered', null, -1, book.stock - 1, null]);
});

test("a variant's changes name it, and the list can show one variant", async () => {
  const shoes = await product(SHOES);
  const [size] = shoes.variants.filter((v) => v.stock > 2);
  await order(customer, [[shoes, 2, size._id]]);
  const all = await history(shoes);
  assert.deepEqual(rows(all)[0], ['ordered', size.label, -2, size.stock - 2, null]);
  assert.deepEqual(
    all.product.variants.find((v) => v.id === size._id.toString()),
    { id: size._id.toString(), label: size.label, stock: size.stock - 2 },
  );
  const other = shoes.variants.find((v) => !v._id.equals(size._id));
  assert.equal((await history(shoes, `?variant=${other._id}`)).total, 0);
  assert.equal((await history(shoes, `?variant=${size._id}`)).total, 1);
  assert.equal((await history(shoes, '?variant=product')).total, 0);
  assert.equal((await admin('GET', `/admin/products/${shoes._id}/stock-history?variant=nope`)).status, 400);
});

test('an approved return puts stock back, recorded with the admin who approved it', async () => {
  const book = await product(BOOK);
  const placed = await order(customer, [[book, 1]]);
  for (const status of ['shipped', 'delivered']) {
    assert.equal((await admin('POST', `/admin/orders/${placed.id}/status`, { status })).status, 200);
  }
  const ret = await customer('POST', `/orders/${placed.id}/returns`, {
    items: [{ index: 0, qty: 1 }],
    reason: 'damaged',
    note: '',
  });
  assert.equal(ret.status, 201, JSON.stringify(ret.body));
  assert.equal((await admin('POST', `/admin/returns/${ret.body.id}/approve`)).status, 200);
  const [returned] = (await history(book)).items;
  assert.equal(returned.reason, 'returned');
  assert.equal(returned.change, 1);
  assert.equal(returned.after, book.stock);
  assert.equal(returned.by, 'Store Owner');
  assert.equal(returned.returnId, ret.body.id);
  assert.deepEqual(returned.order, { id: placed.id, number: placed.number });
});

test('admin saves record only what changed: added, edited, variants switched on and removed', async () => {
  const categoryId = (await t.db.collection('categories').findOne({ slug: 'fashion' }))._id.toString();
  const created = await admin('POST', '/admin/products', {
    title: 'Mitti Tote Bag',
    brand: 'Mitti',
    categoryId,
    price: 49900,
    mrp: 59900,
    stock: 8,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const tote = await product(created.body.slug);
  const edit = (body) => admin('PATCH', `/admin/products/${tote._id}`, body);
  assert.equal((await edit({ brand: 'Mitti Home' })).status, 200); // no stock change, no entry
  assert.equal((await edit({ stock: 5 })).status, 200);
  const switched = await edit({
    variantName: 'Colour',
    variants: [
      { label: 'Red', price: 49900, mrp: 59900, stock: 3 },
      { label: 'Blue', price: 49900, mrp: 59900, stock: 0 },
    ],
  });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  const red = switched.body.variants.find((v) => v.label === 'Red');
  // Blue goes; Red keeps its id and gets one more.
  assert.equal(
    (
      await edit({
        variantName: 'Colour',
        variants: [{ id: red.id, label: 'Red', price: 49900, mrp: 59900, stock: 4 }],
      })
    ).status,
    200,
  );
  assert.deepEqual(rows(await history(tote)), [
    ['edited', 'Red', 1, 4, 'Store Owner'],
    ['edited', 'Red', 3, 3, 'Store Owner'],
    ['edited', null, -5, 0, 'Store Owner'],
    ['edited', null, -3, 5, 'Store Owner'],
    ['added', null, 8, 8, 'Store Owner'],
  ]);
});

test('a CSV import records each stock it sets', async () => {
  const book = await product(BOOK);
  const file = [
    'Slug,Variant,Title,Brand,Category,Price (₹),MRP (₹),Stock,Shown,Highlights,Description',
    `${BOOK},,,,,,,${book.stock + 10},,,`,
    ',,Clay Lamp,Mitti,Home & Kitchen,199,299,6,,,',
  ].join('\n');
  const preview = await admin('POST', '/admin/products/import', Buffer.from(file), 'text/csv');
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const saved = await admin(
    'POST',
    `/admin/products/import/save?plan=${preview.body.plan}`,
    Buffer.from(file),
    'text/csv',
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(rows(await history(book))[0], ['imported', null, 10, book.stock + 10, 'Store Owner']);
  assert.deepEqual(rows(await history(await product('clay-lamp'))), [['imported', null, 6, 6, 'Store Owner']]);
});

test('admins and packers can read it; support staff, customers and visitors cannot', async () => {
  const book = await product(BOOK);
  const path = `/admin/products/${book._id}/stock-history`;
  assert.equal((await packer('GET', path)).status, 200);
  assert.equal((await support('GET', path)).status, 403);
  assert.equal((await customer('GET', path)).status, 403);
  assert.equal((await t.call('GET', path)).status, 401);
  assert.equal((await admin('GET', '/admin/products/000000000000000000000000/stock-history')).status, 404);
  // Packers still can't change products.
  assert.equal((await packer('PATCH', `/admin/products/${book._id}`, { stock: 1 })).status, 403);
});

test('a product switched off variants moves their stock to its own', () => {
  const v = (id, stock) => ({ _id: { toString: () => id }, label: id, stock });
  const at = new Date();
  const entries = savedEntries(
    { _id: 'p', stock: 5, variants: [v('S', 2), v('M', 3)] },
    { _id: 'p', stock: 9, variants: [] },
    { reason: 'edited', by: null, at },
  );
  assert.deepEqual(
    entries.map((e) => [e.label, e.change, e.after]),
    [
      ['S', -2, 0],
      ['M', -3, 0],
      [null, 9, 9],
    ],
  );
});
