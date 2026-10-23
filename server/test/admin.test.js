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
  customer = await register('customer@example.com', 'Asha Rao');
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name, email, password: 'password123' });
  assert.equal(res.status, 201);
  return call;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const categoryId = async (slug) => (await t.db.collection('categories').findOne({ slug }))._id.toString();
const product = (slug) => t.db.collection('products').findOne({ slug });

const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
async function placeOrder(call, slug, qty = 1) {
  const p = await product(slug);
  const quote = await call('GET', `/cart?items=${p._id}:${qty}`);
  const res = await call('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty }],
    address,
    expectedTotal: quote.body.total,
  });
  assert.equal(res.status, 201);
  return res.body;
}

test('admin routes need an admin: 401 logged out, 403 for customers', async () => {
  const routes = [
    ['GET', '/admin/products'],
    ['POST', '/admin/products', {}],
    ['GET', '/admin/categories'],
    ['DELETE', `/admin/categories/${'0'.repeat(24)}`],
    ['GET', '/admin/orders'],
    ['POST', `/admin/orders/${'0'.repeat(24)}/status`, { status: 'shipped' }],
  ];
  for (const [method, path, body] of routes) {
    assert.equal((await t.call(method, path, body)).status, 401, `${method} ${path}`);
    const res = await customer(method, path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.body.error, 'Admins only');
  }
  assert.equal((await t.call('POST', '/admin/images', PNG, 'image/png')).status, 401);
  assert.equal((await customer('POST', '/admin/images', PNG, 'image/png')).status, 403);
  assert.equal((await admin('GET', '/admin/products')).status, 200);
});

test("request info shows an admin their own request's addresses, for the per-network login limit", async () => {
  assert.equal((await t.call('GET', '/admin/request-info')).status, 401);
  assert.equal((await customer('GET', '/admin/request-info')).status, 403);
  const res = await admin('GET', '/admin/request-info');
  assert.equal(res.status, 200);
  assert.match(res.body.ip, /127\.0\.0\.1|::1/);
  assert.equal(res.body.headers['x-forwarded-for'], null);
  assert.deepEqual(Object.keys(res.body.headers), [
    'x-forwarded-for',
    'cf-connecting-ip',
    'true-client-ip',
    'x-real-ip',
    'x-forwarded-proto',
  ]);
});

test('lists, searches and filters products, including hidden ones', async () => {
  const all = await admin('GET', '/admin/products');
  assert.equal(all.body.total, 38);
  assert.equal(all.body.items.length, 38);
  assert.ok(all.body.items[0].description !== undefined && 'active' in all.body.items[0]);

  const search = await admin('GET', '/admin/products?q=sonique');
  assert.equal(search.body.total, 2);

  const mobiles = await admin('GET', `/admin/products?category=${await categoryId('mobiles')}`);
  assert.equal(mobiles.body.total, 7);

  const low = await admin('GET', '/admin/products?status=low');
  assert.equal(low.body.total, await t.db.collection('products').countDocuments({ stock: { $lte: 5 } }));
  assert.ok(low.body.items.every((p) => p.stock <= 5));

  await t.db.collection('products').updateOne({ slug: 'bolt-bass-neckband' }, { $set: { active: false } });
  const hidden = await admin('GET', '/admin/products?status=hidden');
  assert.deepEqual(
    hidden.body.items.map((p) => p.slug),
    ['bolt-bass-neckband'],
  );
  assert.equal((await admin('GET', '/admin/products?status=active')).body.total, 37);
  await t.db.collection('products').updateOne({ slug: 'bolt-bass-neckband' }, { $set: { active: true } });

  for (const qs of ['status=gone', 'category=nope', 'page=0']) {
    assert.equal((await admin('GET', `/admin/products?${qs}`)).status, 400, qs);
  }
});

test('creates a product with a fixed slug and a placeholder image, visible in the store', async () => {
  const body = {
    title: 'Voltix Buds Lite',
    brand: 'Voltix',
    categoryId: await categoryId('audio'),
    price: 149900,
    mrp: 199900,
    stock: 15,
    highlights: ['20h battery', 'IPX4'],
  };
  const res = await admin('POST', '/admin/products', body);
  assert.equal(res.status, 201);
  assert.equal(res.body.slug, 'voltix-buds-lite');
  assert.equal(res.body.active, true);
  assert.equal(res.body.description, '');
  assert.equal(res.body.images.length, 1);
  assert.match(res.body.images[0], /^data:image\/svg\+xml,/);

  const store = await t.call('GET', '/products/voltix-buds-lite');
  assert.equal(store.status, 200);
  assert.equal(store.body.price, 149900);
  assert.deepEqual(store.body.rating, { avg: 0, count: 0 });
  assert.equal(store.body.category.slug, 'audio');

  // Same title again: a numbered slug instead of a clash.
  const again = await admin('POST', '/admin/products', body);
  assert.equal(again.body.slug, 'voltix-buds-lite-2');

  // Renaming keeps the slug, so existing links still work.
  const renamed = await admin('PATCH', `/admin/products/${res.body.id}`, { title: 'Voltix Buds Lite (2026)' });
  assert.equal(renamed.body.slug, 'voltix-buds-lite');
  assert.equal((await t.call('GET', '/products/voltix-buds-lite')).body.title, 'Voltix Buds Lite (2026)');
});

test('validates product input', async () => {
  const valid = {
    title: 'Test item',
    brand: 'Test',
    categoryId: await categoryId('books'),
    price: 10000,
    mrp: 12000,
    stock: 1,
  };
  const cases = [
    [{ ...valid, title: ' ' }, /^title: Enter a title$/],
    [{ ...valid, price: 0 }, /^price: Price must be at least ₹1$/],
    [{ ...valid, price: 99.5 }, /^price:/],
    [{ ...valid, mrp: 5000 }, /^mrp: MRP must be at least the price$/],
    [{ ...valid, stock: -1 }, /^stock:/],
    [{ ...valid, categoryId: '0'.repeat(24) }, /^categoryId: Choose a category$/],
    [{ ...valid, images: ['https://evil.example/x.png'] }, /^images\.0: Invalid image$/],
    [{ ...valid, images: Array(6).fill(`/api/images/${'a'.repeat(24)}`) }, /^images:/],
  ];
  for (const [body, error] of cases) {
    const res = await admin('POST', '/admin/products', body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(res.body.error, error);
  }
  assert.equal(await t.db.collection('products').countDocuments({ title: 'Test item' }), 0);

  const p = await product('orbit-a14-4gb-ram-64gb');
  const tooCheap = await admin('PATCH', `/admin/products/${p._id}`, { mrp: p.price - 100 });
  assert.equal(tooCheap.status, 400);
  assert.equal(tooCheap.body.error, 'mrp: MRP must be at least the price');
  assert.equal((await admin('PATCH', `/admin/products/${'0'.repeat(24)}`, { stock: 1 })).status, 404);
  assert.equal((await admin('PATCH', '/admin/products/nope', { stock: 1 })).status, 400);
});

test('edits price and stock, and hiding removes a product from the store', async () => {
  const p = await product('griha-led-table-lamp');
  const res = await admin('PATCH', `/admin/products/${p._id}`, { price: 69900, stock: 50 });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.price, res.body.stock, res.body.mrp], [69900, 50, p.mrp]);
  assert.equal((await t.call('GET', '/products/griha-led-table-lamp')).body.price, 69900);

  await admin('PATCH', `/admin/products/${p._id}`, { active: false });
  assert.equal((await t.call('GET', '/products/griha-led-table-lamp')).status, 404);
  assert.equal((await t.call('GET', '/products?q=lamp')).body.total, 0);
  const quote = await t.call('GET', `/cart?items=${p._id}:1`);
  assert.equal(quote.body.items[0].problem, 'No longer available');

  await admin('PATCH', `/admin/products/${p._id}`, { active: true });
  assert.equal((await t.call('GET', '/products/griha-led-table-lamp')).status, 200);
});

test('uploads images, serves them with long caching, and rejects bad files', async () => {
  const res = await admin('POST', '/admin/images', PNG, 'image/png');
  assert.equal(res.status, 201);
  assert.match(res.body.url, /^\/api\/images\/[0-9a-f]{24}$/);

  const served = await t.call('GET', res.body.url.slice(4));
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(served.body, PNG);

  // Use it on a product: it shows in the store.
  const p = await product('monsoon-stories-hardcover');
  const edited = await admin('PATCH', `/admin/products/${p._id}`, { images: [res.body.url, p.images[0]] });
  assert.equal(edited.status, 200);
  assert.equal((await t.call('GET', '/products/monsoon-stories-hardcover')).body.image, res.body.url);

  // Removing every image falls back to a placeholder.
  const cleared = await admin('PATCH', `/admin/products/${p._id}`, { images: [] });
  assert.equal(cleared.body.images.length, 1);
  assert.match(cleared.body.images[0], /^data:image\/svg\+xml,/);

  const fake = await admin('POST', '/admin/images', Buffer.from('<svg onload="alert(1)"/>'), 'image/png');
  assert.equal(fake.status, 400);
  assert.equal(fake.body.error, 'This file is not a valid PNG');
  const svg = await admin('POST', '/admin/images', Buffer.from('<svg/>'), 'image/svg+xml');
  assert.equal(svg.status, 400);
  assert.equal(svg.body.error, 'Upload a JPEG, PNG or WebP image');
  const big = await admin('POST', '/admin/images', Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]), 'image/png');
  assert.equal(big.status, 413);
  assert.equal(big.body.error, 'File is too large');

  assert.equal((await t.call('GET', `/images/${'0'.repeat(24)}`)).status, 404);
  assert.equal((await t.call('GET', '/images/nope')).status, 400);
});

test('manages categories: add, rename, reorder, and delete only when empty', async () => {
  const list = await admin('GET', '/admin/categories');
  assert.deepEqual(list.body.map((c) => [c.slug, c.productCount]).slice(0, 2), [
    ['mobiles', 7],
    ['laptops', 6],
  ]);

  const created = await admin('POST', '/admin/categories', { name: 'Toys & Games', icon: '🧸' });
  assert.equal(created.status, 201);
  assert.equal(created.body.slug, 'toys-games');
  assert.equal((await admin('POST', '/admin/categories', { name: 'toys games' })).status, 409);
  assert.equal((await admin('POST', '/admin/categories', { name: '!!!' })).status, 400);

  let store = await t.call('GET', '/categories');
  assert.equal(store.body.at(-1).name, 'Toys & Games');

  const renamed = await admin('PATCH', `/admin/categories/${created.body.id}`, { name: 'Toys' });
  assert.equal(renamed.body.name, 'Toys');
  assert.equal(renamed.body.slug, 'toys-games');

  // Move the new category to the front.
  const ids = (await admin('GET', '/admin/categories')).body.map((c) => c.id);
  const order = [ids.at(-1), ...ids.slice(0, -1)];
  assert.equal((await admin('PUT', '/admin/categories/order', { ids: order })).status, 204);
  store = await t.call('GET', '/categories');
  assert.deepEqual(store.body.map((c) => c.slug).slice(0, 2), ['toys-games', 'mobiles']);
  assert.equal((await admin('PUT', '/admin/categories/order', { ids: order.slice(1) })).status, 400);
  assert.equal((await admin('PUT', '/admin/categories/order', { ids: [order[0], ...order.slice(0, -1)] })).status, 400);

  const notEmpty = await admin('DELETE', `/admin/categories/${await categoryId('books')}`);
  assert.equal(notEmpty.status, 409);
  assert.match(notEmpty.body.error, /^Move or hide its \d+ products first$/);

  assert.equal((await admin('DELETE', `/admin/categories/${created.body.id}`)).status, 204);
  assert.equal((await admin('DELETE', `/admin/categories/${created.body.id}`)).status, 404);
  assert.equal((await t.call('GET', '/categories')).body.length, 6);
});

test('lists all orders with customers, and searches by order number or email', async () => {
  const first = await placeOrder(customer, 'the-quiet-engineer-paperback', 2);
  const other = await register('ravi@example.com', 'Ravi Kumar');
  await placeOrder(other, 'orbit-a14-4gb-ram-64gb');

  const all = await admin('GET', '/admin/orders');
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 2);
  assert.deepEqual(
    all.body.items.map((o) => o.customer.email),
    ['ravi@example.com', 'customer@example.com'],
  );
  assert.equal(all.body.counts.placed, 2);

  const byNumber = await admin('GET', `/admin/orders?q=%23${first.number}`);
  assert.deepEqual(
    byNumber.body.items.map((o) => o.id),
    [first.id],
  );
  const byEmail = await admin('GET', '/admin/orders?q=RAVI@');
  assert.equal(byEmail.body.total, 1);
  assert.equal(byEmail.body.items[0].customer.name, 'Ravi Kumar');
  assert.equal((await admin('GET', '/admin/orders?q=nobody')).body.total, 0);
  assert.equal((await admin('GET', '/admin/orders?status=shipped')).body.total, 0);
  assert.equal((await admin('GET', '/admin/orders?status=lost')).status, 400);

  const one = await admin('GET', `/admin/orders/${first.id}`);
  assert.equal(one.body.customer.name, 'Asha Rao');
  assert.equal(one.body.address.city, 'Bengaluru');
});

test('moves orders placed → shipped → delivered, one step at a time', async () => {
  const order = await placeOrder(customer, 'the-quiet-engineer-paperback');
  const step = (status) => admin('POST', `/admin/orders/${order.id}/status`, { status });

  const skip = await step('delivered');
  assert.equal(skip.status, 409);
  assert.equal(skip.body.error, "A placed order can't be marked delivered");

  const shipped = await step('shipped');
  assert.equal(shipped.status, 200);
  assert.equal(shipped.body.status, 'shipped');
  assert.ok(shipped.body.shippedAt);
  assert.equal(shipped.body.customer.email, 'customer@example.com');
  assert.equal((await step('shipped')).status, 409);

  // Shipped: the customer can no longer cancel, and sees the new status.
  const late = await customer('POST', `/orders/${order.id}/cancel`);
  assert.equal(late.status, 409);
  assert.equal(late.body.error, "This order can't be cancelled (it is shipped)");
  assert.equal((await customer('GET', `/orders/${order.id}`)).body.status, 'shipped');

  const delivered = await step('delivered');
  assert.equal(delivered.body.status, 'delivered');
  assert.ok(delivered.body.deliveredAt);
  const cancel = await step('cancelled');
  assert.equal(cancel.status, 409);
  assert.equal(cancel.body.error, "This order can't be cancelled (it is delivered)");

  assert.equal((await step('placed')).status, 400);
  assert.equal((await admin('POST', `/admin/orders/${'0'.repeat(24)}/status`, { status: 'shipped' })).status, 404);
});

test('an admin can cancel a shipped order, which puts the stock back', async () => {
  const before = (await product('orbit-a14-4gb-ram-64gb')).stock;
  const order = await placeOrder(customer, 'orbit-a14-4gb-ram-64gb', 2);
  await admin('POST', `/admin/orders/${order.id}/status`, { status: 'shipped' });
  assert.equal((await product('orbit-a14-4gb-ram-64gb')).stock, before - 2);

  const res = await admin('POST', `/admin/orders/${order.id}/status`, { status: 'cancelled' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'cancelled');
  assert.equal(res.body.cancelledBy, 'admin');
  assert.equal((await product('orbit-a14-4gb-ram-64gb')).stock, before);
  assert.equal((await customer('GET', `/orders/${order.id}`)).body.cancelledBy, 'admin');
});
