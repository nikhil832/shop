import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { clearComingSoon, sendBackInStockAlerts } from '../src/routes/stockAlerts.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'Store Admin');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
});
after(() => t.stop());

async function register(email, name = 'Asha Rao') {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  call.email = email;
  return call;
}
const categoryId = async (slug) => (await t.db.collection('categories').findOne({ slug }))._id.toString();
const newProduct = async (extra) =>
  admin('POST', '/admin/products', {
    title: 'Orbit Fold X',
    brand: 'Orbit',
    categoryId: await categoryId('mobiles'),
    price: 9999900,
    mrp: 10999900,
    stock: 0,
    ...extra,
  });

test('a product marked coming soon shows it (with the expected day) only while it has no stock', async () => {
  for (const comingSoon of [{ expected: 'next week' }, { expected: '2026-13-45' }, true]) {
    assert.equal((await newProduct({ comingSoon })).status, 400, JSON.stringify(comingSoon));
  }
  const created = await newProduct({ comingSoon: { expected: '2026-11-20' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.comingSoon, { expected: '2026-11-20' });
  const page = (await t.call('GET', `/products/${created.body.slug}`)).body;
  assert.deepEqual(page.comingSoon, { expected: '2026-11-20' });
  assert.equal(page.stock, 0);

  // Without a day; and the home page's list of them.
  const noDay = await newProduct({ title: 'Orbit Band 3', comingSoon: { expected: null } });
  assert.deepEqual(noDay.body.comingSoon, { expected: null });
  const list = (await t.call('GET', '/products?comingSoon=1')).body;
  assert.deepEqual(list.items.map((p) => p.title).sort(), ['Orbit Band 3', 'Orbit Fold X']);
  // Ordinary sold-out products aren't "coming soon".
  assert.ok(list.items.every((p) => p.comingSoon));
  assert.equal((await t.call('GET', '/products?q=orbit fold')).body.items[0].comingSoon.expected, '2026-11-20');

  // Marked on a product that has stock: nothing shows.
  const stocked = await newProduct({ title: 'Orbit Buds', stock: 5, comingSoon: { expected: null } });
  assert.equal((await t.call('GET', `/products/${stocked.body.slug}`)).body.comingSoon, null);
  assert.equal(await clearComingSoon(t.db), 1);
  assert.equal((await t.db.collection('products').findOne({ slug: stocked.body.slug })).comingSoon, null);
});

test('stock arrives: waiting customers are told it has arrived, then the mark goes; the change is logged', async () => {
  const product = (await newProduct({ title: 'Orbit Tab S', comingSoon: { expected: '2026-12-01' } })).body;
  const customer = await register('waiting@example.com');
  assert.equal((await customer('PUT', `/stock-alerts/${product.id}`)).status, 200);

  const saved = await admin('PATCH', `/admin/products/${product.id}`, { stock: 12 });
  assert.equal(saved.status, 200);
  // Until the sweep, stock alone already hides it.
  assert.equal((await t.call('GET', `/products/${product.slug}`)).body.comingSoon, null);
  assert.equal(await sendBackInStockAlerts(t.ctx), 1);
  const mail = t.mail.sent.findLast((m) => m.to.email === 'waiting@example.com');
  assert.equal(mail.subject, 'Now in stock: Orbit Tab S');
  assert.match(mail.text, /Orbit Tab S has arrived, at ₹99,999/);
  await clearComingSoon(t.db);
  const doc = await t.db.collection('products').findOne({ slug: product.slug });
  assert.equal(doc.comingSoon, null);
  // Selling out later reads "Out of stock", not "Coming soon".
  await t.db.collection('products').updateOne({ _id: doc._id }, { $set: { stock: 0 } });
  assert.equal((await t.call('GET', `/products/${product.slug}`)).body.comingSoon, null);

  // Switching it on and off by hand is in the activity log.
  await admin('PATCH', `/admin/products/${product.id}`, { comingSoon: { expected: '2027-01-05' } });
  const entry = await t.db
    .collection('activity')
    .findOne({ action: 'Changed product', 'changes.field': 'Coming soon' }, { sort: { at: -1 } });
  assert.deepEqual(
    entry.changes.find((c) => c.field === 'Coming soon'),
    { field: 'Coming soon', from: 'no', to: 'yes, expected 2027-01-05' },
  );
  // An ordinary sold-out product still says "Back in stock".
  const other = await register('other@example.com');
  const sold = await t.db.collection('products').findOne({ stock: 0, variants: { $exists: false }, comingSoon: null });
  await other('PUT', `/stock-alerts/${sold._id}`);
  await t.db.collection('products').updateOne({ _id: sold._id }, { $set: { stock: 3 } });
  await sendBackInStockAlerts(t.ctx);
  assert.match(t.mail.sent.findLast((m) => m.to.email === 'other@example.com').subject, /^Back in stock: /);
});
