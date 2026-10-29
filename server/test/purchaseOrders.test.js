import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runningOut } from '../src/reorder.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let category;
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Owner', email: 'owner@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  category = (await t.db.collection('categories').findOne({ slug: 'home-kitchen' }))._id.toString();
});
after(() => t.stop());

const DAY = 86_400_000;
let n = 0;
// A product with `stock` (or sizes), added 60 days ago, that sold `sold` in the last 30 days (one order document).
async function product({ stock = 10, sold = 30, cost = 20000, sizes } = {}) {
  const res = await admin('POST', '/admin/products', {
    title: `Copper Bottle ${++n}`,
    brand: 'Griha',
    categoryId: category,
    ...(sizes
      ? {
          variantName: 'Size',
          variants: sizes.map(([label, s]) => ({ label, price: 59900, mrp: 69900, stock: s, cost })),
        }
      : { price: 59900, mrp: 69900, stock, cost }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const doc = await t.db
    .collection('products')
    .findOneAndUpdate(
      { slug: res.body.slug },
      { $set: { createdAt: new Date(Date.now() - 60 * DAY) } },
      { returnDocument: 'after' },
    );
  if (sold) {
    await t.db.collection('orders').insertOne({
      status: 'delivered',
      createdAt: new Date(Date.now() - DAY),
      items: [{ productId: doc._id, ...(sizes && { variantId: doc.variants[0]._id }), qty: sold, price: 59900 }],
    });
  }
  return doc;
}
const receive = (body) => admin('POST', '/admin/stock-receipts', { supplier: 'Tamra Metals', ...body });

test('a supplier order from the reorder suggestions; what is on order comes off the suggestion', async () => {
  const bottle = await product();
  const suggested = (await admin('GET', '/admin/purchase-orders/suggested')).body.lines;
  const line = suggested.find((l) => l.productId === bottle._id.toString());
  // 30 sold in 30 days, 10 left: enough for 30 days is 20 more, at the cost price.
  assert.deepEqual(
    { qty: line.qty, unitCost: line.unitCost, daysLeft: line.daysLeft },
    { qty: 20, unitCost: 20000, daysLeft: 10 },
  );

  // Validation and permissions.
  for (const body of [
    { supplier: '', lines: [{ productId: line.productId, qty: 5 }] },
    { supplier: 'Tamra', lines: [] },
    { supplier: 'Tamra', lines: [{ productId: line.productId, qty: 0 }] },
    { supplier: 'Tamra', expectedOn: 'soon', lines: [{ productId: line.productId, qty: 5 }] },
  ]) {
    assert.equal((await admin('POST', '/admin/purchase-orders', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await t.call('GET', '/admin/purchase-orders')).status, 401);

  const res = await admin('POST', '/admin/purchase-orders', {
    supplier: 'Tamra Metals',
    expectedOn: '2026-11-10',
    note: 'Deliver to the back door',
    lines: [{ productId: line.productId, qty: 12, unitCost: 19000 }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.number, 1);
  assert.equal(res.body.status, 'open');
  assert.equal(res.body.value, 228000);
  assert.equal(res.body.lines[0].title, 'Copper Bottle 1');

  // 12 on order: the suggestion drops to 8, and the row says so.
  const row = (await runningOut(t.db)).items.find((i) => i.productId === line.productId);
  assert.equal(row.onOrder, 12);
  assert.equal(row.suggest, 8);
  assert.ok(await t.db.collection('activity').findOne({ action: 'Made supplier order' }));
});

test('deliveries count towards the order until all has come; a short one can be closed, an untouched one cancelled', async () => {
  const shirt = await product({
    sizes: [
      ['M', 4],
      ['L', 6],
    ],
    sold: 20,
  });
  const [m, l] = shirt.variants.map((v) => v._id.toString());
  const po = (
    await admin('POST', '/admin/purchase-orders', {
      supplier: 'Tamra Metals',
      lines: [
        { productId: shirt._id.toString(), variantId: m, qty: 10 },
        { productId: shirt._id.toString(), variantId: l, qty: 5 },
      ],
    })
  ).body;

  // Part of it, plus something not on the order (counted as stock, not towards the order).
  const extra = await product({ sold: 0 });
  const first = await receive({
    purchaseOrderId: po.id,
    lines: [
      { productId: shirt._id.toString(), variantId: m, qty: 6 },
      { productId: extra._id.toString(), qty: 3 },
    ],
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual(first.body.purchaseOrder, { id: po.id, number: po.number });
  let now = (await admin('GET', `/admin/purchase-orders/${po.id}`)).body;
  assert.equal(now.status, 'open');
  assert.deepEqual(
    now.lines.map((x) => [x.received, x.outstanding]),
    [
      [6, 4],
      [0, 5],
    ],
  );
  assert.deepEqual(
    now.deliveries.map((d) => d.units),
    [9],
  );

  // The rest: received in full.
  await receive({
    purchaseOrderId: po.id,
    lines: [
      { productId: shirt._id.toString(), variantId: m, qty: 4 },
      { productId: shirt._id.toString(), variantId: l, qty: 5 },
    ],
  });
  now = (await admin('GET', `/admin/purchase-orders/${po.id}`)).body;
  assert.equal(now.status, 'received');
  assert.equal(now.received, 15);
  // Nothing more can come against it, and the stock is unchanged by the refusal.
  const before = (await t.db.collection('products').findOne({ _id: shirt._id })).stock;
  const late = await receive({
    purchaseOrderId: po.id,
    lines: [{ productId: shirt._id.toString(), variantId: m, qty: 1 }],
  });
  assert.equal(late.status, 409);
  assert.equal((await t.db.collection('products').findOne({ _id: shirt._id })).stock, before);

  // Closing short, and cancelling.
  const short = (
    await admin('POST', '/admin/purchase-orders', {
      supplier: 'Tamra Metals',
      lines: [{ productId: extra._id.toString(), qty: 10 }],
    })
  ).body;
  await receive({ purchaseOrderId: short.id, lines: [{ productId: extra._id.toString(), qty: 4 }] });
  const refused = await admin('POST', `/admin/purchase-orders/${short.id}/cancel`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'Part of this order has come in: close it instead');
  const closed = await admin('POST', `/admin/purchase-orders/${short.id}/close`);
  assert.equal(closed.body.status, 'closed');
  assert.equal((await admin('POST', `/admin/purchase-orders/${short.id}/close`)).status, 409);

  const untouched = (
    await admin('POST', '/admin/purchase-orders', {
      supplier: 'Tamra Metals',
      lines: [{ productId: extra._id.toString(), qty: 2 }],
    })
  ).body;
  assert.equal((await admin('POST', `/admin/purchase-orders/${untouched.id}/cancel`)).body.status, 'cancelled');
  const list = (await admin('GET', '/admin/purchase-orders?status=open')).body;
  assert.ok(list.items.every((x) => x.status === 'open'));
  assert.deepEqual(
    [list.counts.received, list.counts.closed, list.counts.cancelled].map((c) => c >= 1),
    [true, true, true],
  );
});
