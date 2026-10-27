import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runSales, salePrice } from '../src/sales.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let books;
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Owner', email: 'owner@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  books = await t.db.collection('categories').findOne({ slug: 'books' });
});
after(() => t.stop());

const product = (slug) => t.db.collection('products').findOne({ slug });
const hour = 3_600_000;
const later = (ms) => new Date(Date.now() + ms).toISOString();
const newSale = (body) =>
  admin('POST', '/admin/sales', { name: 'Diwali', percent: 20, startsAt: later(0), endsAt: later(24 * hour), ...body });

test('sale prices: the percentage off, rounded down to whole rupees, never under ₹1', () => {
  assert.equal(salePrice(34900, 10), 31400);
  assert.equal(salePrice(249900, 20), 199900);
  assert.equal(salePrice(100, 90), 100);
});

test('a sale starting now changes the prices at once, variants one by one, and the store shows it', async () => {
  const bookBefore = await product('the-quiet-engineer-paperback');
  const jeansBefore = await product('urbane-men-slim-fit-jeans');
  const res = await newSale({ categoryId: books._id.toString() });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.status, 'running');
  const book = await product('the-quiet-engineer-paperback');
  assert.equal(book.price, salePrice(bookBefore.price, 20));
  assert.equal(book.mrp, bookBefore.mrp);
  assert.equal(book.sale.regularPrice, bookBefore.price);
  const card = (await t.call('GET', '/products/the-quiet-engineer-paperback')).body;
  assert.equal(card.price, book.price);
  assert.deepEqual(Object.keys(card.sale).sort(), ['endsAt', 'name', 'percent']);
  assert.equal(card.sale.name, 'Diwali');
  // Listings and price filters see the sale price.
  const listed = await t.call('GET', `/products?q=quiet%20engineer&maxPrice=${book.price}`);
  assert.equal(listed.body.items[0].slug, 'the-quiet-engineer-paperback');

  // A product with variants: each variant's price, stock untouched; the product's price is the cheapest.
  await newSale({ name: 'Denim days', percent: 10, productIds: [jeansBefore._id.toString()] });
  const jeans = await product('urbane-men-slim-fit-jeans');
  assert.deepEqual(
    jeans.variants.map((v) => [v.price, v.stock]),
    jeansBefore.variants.map((v) => [salePrice(v.price, 10), v.stock]),
  );
  assert.equal(jeans.price, Math.min(...jeans.variants.map((v) => v.price)));
  assert.equal(jeans.stock, jeansBefore.stock);
});

test('prices are locked while on sale, but stock and the rest can change', async () => {
  const book = await product('the-quiet-engineer-paperback');
  const locked = await admin('PATCH', `/admin/products/${book._id}`, { price: 29900 });
  assert.equal(locked.status, 409);
  assert.match(locked.body.error, /in the "Diwali" sale until/);
  assert.equal((await admin('PATCH', `/admin/products/${book._id}`, { mrp: 99900 })).status, 409);
  const stocked = await admin('PATCH', `/admin/products/${book._id}`, { stock: book.stock + 5, price: book.price });
  assert.equal(stocked.status, 200);
  assert.equal(stocked.body.sale.name, 'Diwali');

  // The admin form sends every variant with its (sale) price: fine, as long as none changes.
  const jeans = await product('urbane-men-slim-fit-jeans');
  const variants = jeans.variants.map((v) => ({
    id: v._id.toString(),
    values: v.values,
    price: v.price,
    mrp: v.mrp,
    stock: v.stock + 1,
    images: v.images ?? [],
  }));
  assert.equal(
    (await admin('PATCH', `/admin/products/${jeans._id}`, { options: jeans.options, variants })).status,
    200,
  );
  variants[0].price += 100;
  assert.equal(
    (await admin('PATCH', `/admin/products/${jeans._id}`, { options: jeans.options, variants })).status,
    409,
  );

  // The CSV import too.
  const csv = 'Slug,Price (₹)\nthe-quiet-engineer-paperback,199\n';
  const plan = await admin('POST', '/admin/products/import', Buffer.from(csv), 'text/csv');
  assert.match(JSON.stringify(plan.body), /in the \\"Diwali\\" sale until/);
});

test('a product is in one running sale at a time; ending early puts every price back, stock kept', async () => {
  const book = await product('the-quiet-engineer-paperback');
  const overlap = await newSale({ name: 'Readers week', percent: 50, productIds: [book._id.toString()] });
  const listed = (await admin('GET', '/admin/sales')).body.items;
  const readers = listed.find((s) => s.id === overlap.body.id);
  assert.deepEqual([readers.status, readers.applied, readers.skipped], ['running', 0, 1]);
  assert.equal((await product('the-quiet-engineer-paperback')).price, book.price); // still Diwali's

  // An order during the sale takes stock at the sale price.
  const customer = t.browser();
  await customer('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
  const items = [{ productId: book._id.toString(), qty: 2 }];
  const quote = await customer('GET', `/cart?items=${items[0].productId}:2`);
  const address = {
    name: 'Asha Rao',
    phone: '9876543210',
    line1: '12 MG Road',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
  };
  const order = (await customer('POST', '/orders', { items, address, expectedTotal: quote.body.total })).body;
  assert.equal(order.items[0].price, book.price);

  const diwali = listed.find((s) => s.name === 'Diwali');
  assert.equal((await admin('POST', `/admin/sales/${diwali.id}/end`)).body.status, 'ended');
  const after = await product('the-quiet-engineer-paperback');
  assert.equal(after.price, book.sale.regularPrice);
  assert.equal(after.sale, undefined);
  assert.equal(after.stock, book.stock - 2); // the order's stock change stands
  assert.equal((await admin('POST', `/admin/sales/${diwali.id}/end`)).status, 409);

  const denim = listed.find((s) => s.name === 'Denim days');
  const jeansOnSale = await product('urbane-men-slim-fit-jeans');
  await admin('POST', `/admin/sales/${denim.id}/end`);
  const jeans = await product('urbane-men-slim-fit-jeans');
  assert.deepEqual(
    jeans.variants.map((v) => v.price),
    jeansOnSale.sale.regularVariants.map((r) => r.price),
  );
  assert.equal(jeans.price, jeansOnSale.sale.regularPrice);
  const actions = (await admin('GET', '/admin/activity?area=sales')).body.items.map((e) => e.action);
  assert.ok(actions.includes('Scheduled sale') && actions.includes('Ended sale early'));
});

test('a scheduled sale starts and ends with the sweep; one called off never starts', async () => {
  const kettle = await product('rasoi-mixer-grinder-750w');
  const start = Date.now() + 2 * hour;
  const res = await newSale({
    name: 'Weekend',
    percent: 15,
    productIds: [kettle._id.toString()],
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 2 * 24 * hour).toISOString(),
  });
  assert.equal(res.body.status, 'upcoming');
  assert.equal((await product('rasoi-mixer-grinder-750w')).price, kettle.price);
  await runSales(t.ctx, new Date(start + 60_000));
  assert.equal((await product('rasoi-mixer-grinder-750w')).price, salePrice(kettle.price, 15));
  await runSales(t.ctx, new Date(start + 2 * 24 * hour));
  assert.equal((await product('rasoi-mixer-grinder-750w')).price, kettle.price);

  const off = await newSale({ name: 'Maybe', productIds: [kettle._id.toString()], startsAt: later(hour) });
  assert.equal((await admin('POST', `/admin/sales/${off.body.id}/end`)).body.status, 'cancelled');
  await runSales(t.ctx, new Date(Date.now() + 2 * hour));
  assert.equal((await product('rasoi-mixer-grinder-750w')).price, kettle.price);
});

test('sales are checked, and only for admins', async () => {
  const book = (await product('the-quiet-engineer-paperback'))._id.toString();
  for (const [body, error] of [
    [{ percent: 0, productIds: [book] }, /From 1% off/],
    [{ percent: 91, productIds: [book] }, /At most 90% off/],
    [{ productIds: [book], endsAt: later(-hour) }, /end must be after the start/],
    [{ productIds: [book], endsAt: later(40 * 24 * hour) }, /at most 31 days/],
    [{}, /Choose a category or some products/],
    [{ productIds: [book], categoryId: books._id.toString() }, /Choose a category or some products/],
    [{ productIds: ['000000000000000000000000'] }, /no longer exists/],
  ]) {
    const res = await newSale(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, error);
  }
  const customer = t.browser();
  await customer('POST', '/auth/register', { name: 'Ravi K', email: 'ravi@example.com', password: 'password123' });
  assert.equal((await customer('GET', '/admin/sales')).status, 403);
  assert.equal((await customer('POST', '/admin/sales', {})).status, 403);
  assert.equal((await admin('POST', '/admin/sales/000000000000000000000000/end')).status, 404);
});
