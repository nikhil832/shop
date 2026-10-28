import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'Store Admin');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  customer = await register('customer@example.com', 'Asha Rao');
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name, email, password: 'password123' });
  assert.equal(res.status, 201);
  return call;
}

const IST = 330 * 60_000;
// An India-time moment ("2026-03-05 10:30") as a Date.
const ist = (s) => new Date(Date.parse(`${s.replace(' ', 'T')}:00Z`) - IST);

let number = 500000;
async function addOrder({ at, status = 'placed', name = 'Asha Rao', items, discount = 0, coupon, payment }) {
  const user = await t.db.collection('users').findOne({ email: 'customer@example.com' });
  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const doc = {
    number: ++number,
    userId: user._id,
    items: items.map((i) => ({ productId: new ObjectId(), image: null, ...i })),
    subtotal,
    delivery: subtotal >= 49900 ? 0 : 4000,
    discount,
    ...(coupon && { coupon: { code: coupon, type: 'flat' } }),
    total: subtotal + (subtotal >= 49900 ? 0 : 4000) - discount,
    address: {
      name,
      phone: '9876543210',
      line1: '12 MG Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
    },
    payment: payment ?? { method: 'cod' },
    status,
    createdAt: ist(at),
    updatedAt: ist(at),
  };
  await t.db.collection('orders').insertOne(doc);
  return doc;
}

const csv = (res) => res.body.toString('utf8');
const rows = (res) =>
  csv(res)
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split('\r\n');

test('the export needs an admin and a valid date range', async () => {
  const path = '/admin/orders/export?from=2026-03-01&to=2026-03-31';
  assert.equal((await t.call('GET', path)).status, 401);
  assert.equal((await customer('GET', path)).status, 403);

  for (const [query, error] of [
    ['from=2026-03-01', 'to: Choose a date'],
    ['from=2026-02-30&to=2026-03-01', 'Choose a date'],
    ['from=2026-03-10&to=2026-03-01', 'The end date must be on or after the start date'],
    ['from=2025-01-01&to=2026-03-01', 'Choose at most 366 days'],
    ['from=2026-03-01&to=2026-03-31&status=lost', null],
  ]) {
    const res = await admin('GET', `/admin/orders/export?${query}`);
    assert.equal(res.status, 400, query);
    if (error) assert.equal(res.body.error, error, query);
  }
});

test('downloads the orders in the range as a CSV, one row per order, in India time', async () => {
  // Just after midnight India time on 1 March is still 28 February in UTC: it counts as 1 March.
  const first = await addOrder({
    at: '2026-03-01 00:10',
    items: [
      { title: 'Orbit A14 (4GB RAM, 64GB)', price: 899900, qty: 2 },
      { title: 'The Quiet Engineer', price: 34900, qty: 1 },
    ],
    discount: 10000,
    coupon: 'WELCOME100',
    payment: { method: 'razorpay', status: 'paid' },
  });
  await addOrder({ at: '2026-03-31 23:50', status: 'delivered', items: [{ title: 'Pen, blue', price: 2000, qty: 3 }] });
  // Outside the range on either side.
  await addOrder({ at: '2026-02-28 23:50', items: [{ title: 'Too early', price: 1000, qty: 1 }] });
  await addOrder({ at: '2026-04-01 00:10', items: [{ title: 'Too late', price: 1000, qty: 1 }] });

  const res = await admin('GET', '/admin/orders/export?from=2026-03-01&to=2026-03-31');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="orders-2026-03-01-to-2026-03-31.csv"');
  assert.ok(csv(res).startsWith('\uFEFF'));

  const [header, ...lines] = rows(res);
  assert.equal(
    header,
    'Order,Date (India time),Status,Customer,Email,Items,Item details,Items total (₹),Delivery (₹),Discount (₹),Coupon,Total (₹),Refunded (₹),Net total (₹),Place of supply,Taxable value (₹),CGST (₹),SGST (₹),IGST (₹),Payment,Payment status,Store credit (₹),Item cost (₹),City,State,PIN code,Courier,Tracking number',
  );
  assert.equal(lines.length, 2);
  assert.equal(
    lines[0],
    `${first.number},2026-03-01 00:10,placed,Asha Rao,customer@example.com,3,` +
      '"Orbit A14 (4GB RAM, 64GB) × 2; The Quiet Engineer × 1",18347.00,0.00,100.00,WELCOME100,18247.00,0.00,18247.00,,,,,,' +
      'Online,paid,0.00,,Bengaluru,Karnataka,560001,,',
  );
  // Fields with commas are quoted; amounts are rupees with two decimals.
  assert.ok(lines[1].includes(',2026-03-31 23:50,delivered,'));
  assert.ok(
    lines[1].includes(',"Pen, blue × 3",60.00,40.00,0.00,,100.00,0.00,100.00,,,,,,Cash on Delivery,,'),
    lines[1],
  );

  // One status only.
  const delivered = await admin('GET', '/admin/orders/export?from=2026-03-01&to=2026-03-31&status=delivered');
  assert.equal(rows(delivered).length, 2);
  assert.match(delivered.headers.get('content-disposition'), /orders-2026-03-01-to-2026-03-31-delivered\.csv/);
  // An empty range still has the header row.
  assert.equal(rows(await admin('GET', '/admin/orders/export?from=2026-05-01&to=2026-05-01')).length, 1);
});

test('text a customer typed is quoted and never runs as a spreadsheet formula', async () => {
  await addOrder({
    at: '2026-06-10 12:00',
    name: '=HYPERLINK("http://evil.example","click")',
    items: [{ title: '@SUM(1+1)', price: 1000, qty: 1 }],
  });
  const [, line] = rows(await admin('GET', '/admin/orders/export?from=2026-06-10&to=2026-06-10'));
  // The customer column shows the account name; the address name only fills in for a deleted account.
  assert.ok(line.includes(",'@SUM(1+1) × 1,"), line);

  await t.db.collection('users').updateOne({ email: 'customer@example.com' }, { $set: { name: '+cmd|calc' } });
  try {
    const [, again] = rows(await admin('GET', '/admin/orders/export?from=2026-06-10&to=2026-06-10'));
    assert.ok(again.includes(",'+cmd|calc,"), again);
  } finally {
    await t.db.collection('users').updateOne({ email: 'customer@example.com' }, { $set: { name: 'Asha Rao' } });
  }
});

test('/admin/orders/:id still finds orders', async () => {
  const order = await addOrder({ at: '2026-07-01 09:00', items: [{ title: 'Notebook', price: 9900, qty: 1 }] });
  const res = await admin('GET', `/admin/orders/${order._id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.number, order.number);
});

test("approved returns show as the order's refund and net total", async () => {
  const order = await addOrder({
    at: '2026-08-05 10:00',
    status: 'delivered',
    items: [{ title: 'Mug', price: 50000, qty: 2 }],
  });
  const ret = (status, refund) => ({
    orderId: order._id,
    userId: order.userId,
    items: [],
    refund,
    status,
    createdAt: new Date(),
  });
  await t.db
    .collection('returns')
    .insertMany([ret('refunded', 50000), ret('declined', 50000), ret('requested', 50000)]);
  const [, line] = rows(await admin('GET', '/admin/orders/export?from=2026-08-05&to=2026-08-05'));
  assert.ok(line.includes(',1000.00,500.00,500.00,,,,,,Cash on Delivery,'), line);
});
