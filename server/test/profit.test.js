import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { profitFor } from '../src/profit.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  customer = await register('customer@example.com', 'Asha Rao');
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}

const BOOK = 'the-quiet-engineer-paperback'; // ₹349
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
async function buy(slug, qty, variantId) {
  const p = await product(slug);
  const key = `${p._id}${variantId ? `.${variantId}` : ''}`;
  const quote = await customer('GET', `/cart?items=${key}:${qty}`);
  const res = await customer('POST', '/orders', {
    items: [{ productId: p._id.toString(), ...(variantId && { variantId: variantId.toString() }), qty }],
    address,
    expectedTotal: quote.body.total,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('admins set cost prices for products and options; customers never see them', async () => {
  const book = await product(BOOK);
  assert.equal((await admin('PATCH', `/admin/products/${book._id}`, { cost: 20000 })).body.cost, 20000);

  const shoes = await product(SHOES);
  const sizes = (await admin('GET', `/admin/products/${shoes._id}`)).body.variants;
  const edited = await admin('PATCH', `/admin/products/${shoes._id}`, {
    variantName: 'Size',
    variants: sizes.map((v, i) => ({
      id: v.id,
      label: v.label,
      price: v.price,
      mrp: v.mrp,
      stock: v.stock,
      cost: i ? 150000 : null,
    })),
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(
    edited.body.variants.map((v) => v.cost),
    sizes.map((v, i) => (i ? 150000 : null)),
  );
  // A save that doesn't mention cost (an older form) keeps it.
  const kept = await admin('PATCH', `/admin/products/${shoes._id}`, {
    variantName: 'Size',
    variants: sizes.map((v) => ({ id: v.id, label: v.label, price: v.price, mrp: v.mrp, stock: v.stock })),
  });
  assert.equal(kept.body.variants[1].cost, 150000);
  const log = await t.db.collection('activity').find({ area: 'products' }).sort({ at: 1 }).toArray();
  assert.ok(log.some((e) => e.changes.some((c) => c.field === 'Cost' && c.to === '₹200')));

  // Nowhere in the shop.
  for (const path of [
    `/products/${BOOK}`,
    `/products/${SHOES}`,
    '/products?q=quiet',
    `/compare?slugs=${BOOK},${SHOES}`,
  ]) {
    const text = JSON.stringify((await t.call('GET', path)).body);
    assert.ok(!text.includes('"cost"'), path);
  }
  assert.equal((await admin('PATCH', `/admin/products/${book._id}`, { cost: -1 })).status, 400);
});

test('orders keep the cost they were sold at; customers see orders without it', async () => {
  const order = await buy(BOOK, 2);
  assert.ok(!JSON.stringify(order).includes('"cost"'));
  assert.ok(!JSON.stringify((await customer('GET', `/orders/${order.id}`)).body).includes('"cost"'));
  assert.equal((await admin('GET', `/admin/orders/${order.id}`)).body.items[0].cost, 20000);
  // A later change of cost leaves the order as it was.
  await admin('PATCH', `/admin/products/${(await product(BOOK))._id}`, { cost: 25000 });
  const doc = await t.db.collection('orders').findOne({ number: order.number });
  assert.equal(doc.items[0].cost, 20000);
});

test('profit: sales less coupon share and cost, returns taken off, items without a cost left out', async () => {
  const db = t.db;
  const from = new Date('2026-01-01T00:00:00Z');
  const to = new Date('2026-02-01T00:00:00Z');
  const a = new ObjectId();
  const b = new ObjectId();
  const productId = new ObjectId();
  const other = new ObjectId();
  await db.collection('orders').insertMany([
    {
      // ₹1,000 of a costed item (₹600 cost) and ₹1,000 of one without cost, ₹200 coupon off: half is the costed one's.
      _id: a,
      status: 'delivered',
      createdAt: new Date('2026-01-10T00:00:00Z'),
      subtotal: 200000,
      discount: 20000,
      coupon: { code: 'X', type: 'flat' },
      items: [
        { productId, price: 50000, qty: 2, cost: 30000 },
        { productId: other, price: 100000, qty: 1 },
      ],
    },
    {
      // Two at ₹500 (cost ₹300), one returned.
      _id: b,
      status: 'shipped',
      createdAt: new Date('2026-01-20T00:00:00Z'),
      subtotal: 100000,
      items: [{ productId, price: 50000, qty: 2, cost: 30000 }],
    },
    // Cancelled and out-of-period orders don't count.
    {
      status: 'cancelled',
      createdAt: new Date('2026-01-15T00:00:00Z'),
      subtotal: 50000,
      items: [{ productId, price: 50000, qty: 1, cost: 1 }],
    },
    {
      status: 'placed',
      createdAt: new Date('2026-02-02T00:00:00Z'),
      subtotal: 50000,
      items: [{ productId, price: 50000, qty: 1, cost: 1 }],
    },
  ]);
  await db.collection('returns').insertOne({ orderId: b, status: 'refunded', items: [{ index: 0, qty: 1 }] });

  const p = await profitFor(db, from, to);
  // Sales: (100000 − 10000) + 50000 = 140000; cost: 60000 + 30000 = 90000.
  assert.deepEqual(
    {
      sales: p.sales,
      cost: p.cost,
      profit: p.profit,
      margin: p.margin,
      items: p.items,
      uncostedItems: p.uncostedItems,
    },
    { sales: 140000, cost: 90000, profit: 50000, margin: 35.7, items: 4, uncostedItems: 1 },
  );
  assert.equal(p.byProduct.get(productId.toString()), 50000);
  await db.collection('orders').deleteMany({ _id: { $in: [a, b] } });
  await db.collection('orders').deleteMany({ createdAt: { $gte: from, $lt: new Date('2026-03-01') } });
});

test('the dashboard shows profit and margin, best sellers’ profit and what a reorder would cost', async () => {
  const shoes = await product(SHOES);
  const size = shoes.variants[1]; // cost ₹1,500
  await buy(SHOES, 9, size._id);
  const res = await admin('GET', '/admin/dashboard?days=7');
  assert.equal(res.status, 200);
  const { profit, bestSellers, runningOut } = res.body;
  // Two books at ₹349 (cost ₹200 then) and nine shoes at the size's price (cost ₹1,500).
  const expectedSales = 2 * 34900 + 9 * size.price;
  const expectedCost = 2 * 20000 + 9 * 150000;
  assert.deepEqual(
    [profit.sales, profit.cost, profit.profit, profit.uncostedItems],
    [expectedSales, expectedCost, expectedSales - expectedCost, 0],
  );
  assert.equal(bestSellers.find((b) => b.slug === SHOES).profit, 9 * size.price - 9 * 150000);
  const row = runningOut.items.find((r) => r.variantId === size._id.toString());
  if (row) assert.equal(row.suggestCost, row.suggest * 150000);
});

test('the product file has a cost column: exported, and imported like the other numbers', async () => {
  const csv = (await admin('GET', '/admin/products/export')).body.toString();
  const bookLine = csv.split('\r\n').find((l) => l.startsWith(`${BOOK},`));
  assert.ok(bookLine.includes(',250.00,'), bookLine); // cost ₹250 since the earlier change
  const file = Buffer.from(`Slug,Variant,Cost (₹)\n${BOOK},,180`);
  const preview = await admin('POST', '/admin/products/import', file, 'text/csv');
  assert.deepEqual(preview.body.rows[0].changes, [{ field: 'cost', from: 25000, to: 18000 }]);
  assert.equal(
    (await admin('POST', `/admin/products/import/save?plan=${preview.body.plan}`, file, 'text/csv')).status,
    200,
  );
  assert.equal((await product(BOOK)).cost, 18000);
});
