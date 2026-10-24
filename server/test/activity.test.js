import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { startTestServer } from './helpers.js';

let t;
let admin;
let helper;
let customer;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  helper = await register('helper@example.com', 'Shop Helper');
  await t.db
    .collection('users')
    .updateMany({ email: { $in: ['owner@example.com', 'helper@example.com'] } }, { $set: { role: 'admin' } });
  customer = await register('customer@example.com', 'Asha Rao');
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}

// The newest entry (optionally of one area).
async function latest(area) {
  const res = await admin('GET', `/admin/activity${area ? `?area=${area}` : ''}`);
  assert.equal(res.status, 200);
  return res.body.items[0];
}
const product = (slug) => t.db.collection('products').findOne({ slug });

test('only admins see the log', async () => {
  assert.equal((await t.call('GET', '/admin/activity')).status, 401);
  assert.equal((await customer('GET', '/admin/activity')).status, 403);
  assert.equal((await admin('GET', '/admin/activity?area=nothing')).status, 400);
  assert.equal((await admin('GET', '/admin/activity?by=someone')).status, 400);
});

test('product changes say who, what and each change; a save that changes nothing adds nothing', async () => {
  const book = await product('the-quiet-engineer-paperback');
  const res = await admin('PATCH', `/admin/products/${book._id}`, { price: 29900, stock: 50, active: false });
  assert.equal(res.status, 200);
  const entry = await latest();
  assert.equal(entry.area, 'products');
  assert.equal(entry.action, 'Changed product');
  assert.deepEqual(entry.by, { id: entry.by.id, name: 'Store Owner', email: 'owner@example.com' });
  assert.deepEqual(entry.target, { label: 'The Quiet Engineer (Paperback)', path: `/admin/products/${book._id}` });
  assert.deepEqual(entry.changes, [
    { field: 'Shown', from: 'yes', to: 'no' },
    { field: 'Price', from: '₹349', to: '₹299' },
    { field: 'Stock', from: String(book.stock), to: '50' },
  ]);
  assert.ok(Date.now() - new Date(entry.at) < 60_000);

  await admin('PATCH', `/admin/products/${book._id}`, { price: 29900 });
  assert.equal((await latest()).id, entry.id);
  await admin('PATCH', `/admin/products/${book._id}`, { active: true });

  // Sizes: each one's change, by its label.
  const shoes = await product('stride-running-shoes');
  const variants = shoes.variants.map((v, i) => ({
    id: v._id.toString(),
    label: v.label,
    price: v.price,
    mrp: v.mrp,
    stock: i === 0 ? v.stock + 5 : v.stock,
  }));
  await admin('PATCH', `/admin/products/${shoes._id}`, { variantName: 'Size', variants });
  assert.deepEqual((await latest()).changes, [
    {
      field: `${shoes.variants[0].label}: stock`,
      from: String(shoes.variants[0].stock),
      to: String(shoes.variants[0].stock + 5),
    },
  ]);

  const created = await admin('POST', '/admin/products', {
    title: 'Clay Mug',
    brand: 'Mitti',
    categoryId: book.categoryId.toString(),
    price: 29900,
    mrp: 39900,
    stock: 4,
  });
  assert.equal(created.status, 201);
  const added = await latest();
  assert.equal(added.action, 'Added product');
  assert.deepEqual(added.changes, [
    { field: 'Category', to: 'Books' },
    { field: 'Price', to: '₹299' },
    { field: 'Stock', to: '4' },
    { field: 'Shown', to: 'yes' },
  ]);
});

test('categories, orders, coupons, delivery, reviews and settings are logged', async () => {
  const cat = await helper('POST', '/admin/categories', { name: 'Toys' });
  let entry = await latest('categories');
  assert.deepEqual([entry.action, entry.target.label, entry.by.name], ['Added category', 'Toys', 'Shop Helper']);
  await helper('PATCH', `/admin/categories/${cat.body.id}`, { name: 'Games' });
  assert.deepEqual((await latest('categories')).changes, [{ field: 'Name', from: 'Toys', to: 'Games' }]);
  await helper('DELETE', `/admin/categories/${cat.body.id}`);
  entry = await latest('categories');
  assert.deepEqual([entry.action, entry.target], ['Deleted category', { label: 'Games', path: null }]);

  // An order shipped with tracking, then the tracking corrected.
  const item = await product('bolt-bass-neckband');
  const placed = await customer('POST', '/orders', {
    items: [{ productId: item._id.toString(), qty: 1 }],
    address: {
      name: 'Asha Rao',
      phone: '9876543210',
      line1: '1 MG Road',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411001',
    },
    payment: 'cod',
    expectedTotal: (await customer('GET', `/cart?items=${item._id}:1`)).body.total,
  });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const orderId = placed.body.id;
  await admin('POST', `/admin/orders/${orderId}/status`, {
    status: 'shipped',
    shipment: { courier: 'Delhivery', trackingNumber: 'DL123' },
  });
  entry = await latest('orders');
  assert.equal(entry.action, 'Marked shipped');
  assert.deepEqual(entry.target, { label: `Order #${placed.body.number}`, path: `/admin/orders/${orderId}` });
  assert.deepEqual(entry.changes, [{ field: 'Tracking', to: 'Delhivery DL123' }]);
  await admin('PUT', `/admin/orders/${orderId}/shipment`, { courier: '', trackingNumber: '', trackingUrl: '' });
  assert.deepEqual((await latest('orders')).changes, [{ field: 'Tracking', to: 'removed' }]);

  const coupon = await admin('POST', '/admin/coupons', {
    code: 'DIWALI10',
    type: 'percent',
    value: 10,
    maxDiscount: 20000,
  });
  assert.equal(coupon.status, 201, JSON.stringify(coupon.body));
  assert.deepEqual((await latest('coupons')).changes, [{ field: 'Offer', to: '10% off (up to ₹200)' }]);
  await admin('PATCH', `/admin/coupons/${coupon.body.id}`, { active: false });
  assert.equal((await latest('coupons')).action, 'Switched off coupon');
  await admin('PATCH', `/admin/coupons/${coupon.body.id}`, { active: false }); // already off: nothing new
  assert.equal((await latest()).action, 'Switched off coupon');

  await admin('POST', '/admin/delivery/zones', {
    prefix: '411',
    name: 'Pune',
    deliverable: true,
    minDays: 1,
    maxDays: 2,
  });
  assert.deepEqual((await latest('delivery')).target, { label: '411 (Pune), 1–2 days', path: '/admin/delivery' });
  await admin('PUT', '/admin/delivery/everywhere-else', { deliverable: false });
  assert.deepEqual((await latest('delivery')).changes, [{ field: 'Delivery', from: '3–7 days', to: 'no delivery' }]);

  await admin('PUT', '/admin/dashboard/low-stock-email', { enabled: false });
  assert.equal((await latest('settings')).action, 'Switched off the low-stock email');
  await admin('PUT', '/admin/dashboard/low-stock-email', { enabled: true });
  assert.equal((await latest('settings')).action, 'Switched on the low-stock email');

  // A review hidden (stored directly: reviews need a delivered order).
  const { insertedId } = await t.db.collection('reviews').insertOne({
    productId: item._id,
    userId: (await t.db.collection('users').findOne({ email: 'customer@example.com' }))._id,
    rating: 2,
    title: 'Meh',
    body: '',
    author: 'Asha R.',
    hidden: false,
    createdAt: new Date(),
  });
  await admin('POST', `/admin/reviews/${insertedId}/visibility`, { hidden: true });
  entry = await latest('reviews');
  assert.equal(entry.action, 'Hid review');
  assert.equal(entry.target.label, `2★ by Asha R. of ${item.title}`);
  await admin('POST', `/admin/reviews/${insertedId}/visibility`, { hidden: true }); // already hidden
  assert.equal((await latest()).id, entry.id);
});

test('a CSV import is one entry listing every change', async () => {
  const csv = 'Slug,Price (₹)\nthe-quiet-engineer-paperback,279\nbolt-bass-neckband,\n';
  const check = await admin('POST', '/admin/products/import', Buffer.from(csv), 'text/csv');
  await admin('POST', `/admin/products/import/save?plan=${check.body.plan}`, Buffer.from(csv), 'text/csv');
  const entry = await latest('products');
  assert.equal(entry.action, 'Imported products from a CSV file: 0 added, 1 updated');
  assert.deepEqual(entry.changes, [{ field: 'The Quiet Engineer (Paperback): Price', from: '₹299', to: '₹279' }]);
});

test('filters by area and person, newest first; the command line is logged too', async () => {
  const all = await admin('GET', '/admin/activity');
  assert.ok(all.body.total >= 15);
  const times = all.body.items.map((e) => new Date(e.at).getTime());
  assert.deepEqual(
    times,
    [...times].sort((a, b) => b - a),
  );
  const helperId = all.body.people.find((p) => p.name === 'Shop Helper').id;
  const byHelper = await admin('GET', `/admin/activity?by=${helperId}`);
  assert.equal(byHelper.body.total, 3);
  assert.ok(byHelper.body.items.every((e) => e.area === 'categories'));

  // npm run make-admin, against this test database.
  const run = spawnSync(process.execPath, ['src/make-admin.js', 'customer@example.com'], {
    cwd: new URL('..', import.meta.url),
    env: { PATH: process.env.PATH, MONGODB_URI: t.uri, MONGODB_DB: 'test' },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const entry = await latest('accounts');
  assert.deepEqual([entry.by, entry.action, entry.target.label], [null, 'Made an admin', 'customer@example.com']);
  const cli = await admin('GET', '/admin/activity?by=cli');
  assert.equal(cli.body.total, 1);
  assert.ok((await admin('GET', '/admin/activity')).body.people.some((p) => p.id === 'cli'));
});

test('entries expire after a year', async () => {
  const indexes = await t.db.collection('activity').indexes();
  assert.equal(indexes.find((i) => i.key.at === 1).expireAfterSeconds, 365 * 86_400);
});
