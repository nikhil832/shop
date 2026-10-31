import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  customer = t.browser();
  await customer('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
});
after(() => t.stop());

const DAY = 86_400_000;
const product = (slug) => t.db.collection('products').findOne({ slug });
let number = 200000;

// A delivered order of `lines` [[product, qty]], stored directly `daysAgo` days ago.
async function addOrder(lines, { daysAgo = 1, status = 'delivered' } = {}) {
  const createdAt = new Date(Date.now() - daysAgo * DAY);
  const { insertedId } = await t.db.collection('orders').insertOne({
    number: ++number,
    userId: new ObjectId(),
    items: lines.map(([p, qty]) => ({ productId: p._id, title: p.title, price: p.price, qty })),
    total: 0,
    status,
    createdAt,
    updatedAt: createdAt,
  });
  return { _id: insertedId, number, createdAt };
}
// A return (or exchange) of `lines` [[product, qty]] from `order`.
async function addRequest(kind, order, lines, reason, { status = 'requested', note = '' } = {}) {
  await t.db.collection(kind === 'return' ? 'returns' : 'exchanges').insertOne({
    orderId: order._id,
    orderNumber: order.number,
    items: lines.map(([p, qty]) => ({ productId: p._id, title: p.title, qty })),
    reason,
    note,
    status,
    createdAt: new Date(),
  });
}

test('admins see which products come back, how often and why', async () => {
  const shoes = await product('stride-running-shoes');
  const book = await product('learning-to-code-with-javascript');
  const a = await addOrder([
    [shoes, 4],
    [book, 1],
  ]);
  const b = await addOrder([[shoes, 6]]);
  await addOrder([[book, 9]]);
  const old = await addOrder([[shoes, 5]], { daysAgo: 100 });

  await addRequest('return', a, [[shoes, 2]], 'damaged', { note: 'Sole came off on day one' });
  await addRequest('exchange', b, [[shoes, 1]], 'fit');
  await addRequest('return', b, [[shoes, 1]], 'not_as_described', { status: 'refunded' });
  await addRequest('return', a, [[book, 1]], 'changed_mind');
  // Not counted: declined, called off, or from an order before the period.
  await addRequest('return', b, [[shoes, 3]], 'damaged', { status: 'declined' });
  await addRequest('exchange', a, [[shoes, 1]], 'fit', { status: 'cancelled' });
  await addRequest('return', old, [[shoes, 5]], 'damaged', { note: 'Old one' });

  const res = await admin('GET', '/admin/return-reasons?days=90');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(
    res.body.reasons.map((r) => [r.label, r.units]),
    [
      ['Arrived damaged or faulty', 2],
      ['Changed my mind', 1],
      ["Doesn't fit (exchange)", 1],
      ["Doesn't match the description", 1],
    ],
  );
  assert.deepEqual(
    res.body.products.map((p) => [p.title, p.sold, p.returned, p.exchanged, p.rate]),
    [
      [shoes.title, 10, 3, 1, 40],
      [book.title, 10, 1, 0, 10],
    ],
  );
  assert.equal(res.body.products[0].slug, shoes.slug);
  assert.deepEqual(res.body.products[0].reasons[0], {
    reason: 'return:damaged',
    label: 'Arrived damaged or faulty',
    units: 2,
  });
  assert.deepEqual(
    res.body.notes.map((n) => [n.kind, n.note, n.number, n.titles]),
    [['return', 'Sole came off on day one', a.number, [shoes.title]]],
  );

  // A year takes in the older order (and its note).
  const year = (await admin('GET', '/admin/return-reasons?days=365')).body;
  assert.deepEqual(year.products[0].sold, 15);
  assert.equal(year.products[0].returned, 8);
  assert.equal(year.notes.length, 2);
});

test('admins only, and a known period', async () => {
  assert.equal((await customer('GET', '/admin/return-reasons')).status, 403);
  assert.equal((await t.browser()('GET', '/admin/return-reasons')).status, 401);
  assert.equal((await admin('GET', '/admin/return-reasons?days=7')).status, 400);
});
