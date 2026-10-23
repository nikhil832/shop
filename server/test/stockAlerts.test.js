import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureIndexes } from '../src/db.js';
import { sendBackInStockAlerts } from '../src/routes/stockAlerts.js';
import { startTestServer } from './helpers.js';

let t;
let products;
let alerts;
before(async () => {
  t = await startTestServer();
  products = t.db.collection('products');
  alerts = t.db.collection('stockAlerts');
});
after(() => t.stop());

let n = 0;
async function register() {
  const email = `waiter${++n}@example.com`;
  const call = t.browser();
  assert.equal(
    (await call('POST', '/auth/register', { name: 'Kavya Menon', email, password: 'password123' })).status,
    201,
  );
  call.email = email;
  return call;
}

// Each test takes its own sold-out product (the sample catalog has 5), so they don't affect each other.
const SOLD_OUT = ['ferro-chromebook-11', 'stride-casual-sneakers', 'aura-electric-kettle-1-5l', 'cooking-without-fuss'];
const product = (slug) => products.findOne({ slug });
const restock = (slug, stock) => products.updateOne({ slug }, { $set: { stock } });
const mailsTo = (call) => t.mail.sent.filter((m) => m.to.email === call.email && m.subject.startsWith('Back in stock'));

test('alerts need a login, an existing out-of-stock product, and show on the product page', async () => {
  const p = await product(SOLD_OUT[0]);
  assert.equal(p.stock, 0);
  assert.equal((await t.call('PUT', `/stock-alerts/${p._id}`)).status, 401);

  const call = await register();
  assert.equal((await call('GET', `/products/${p.slug}`)).body.stockAlert, false);
  assert.deepEqual((await call('PUT', `/stock-alerts/${p._id}`)).body, { stockAlert: true });
  assert.deepEqual((await call('PUT', `/stock-alerts/${p._id}`)).body, { stockAlert: true }); // once only
  assert.equal(await alerts.countDocuments({ productId: p._id }), 1);
  assert.equal((await call('GET', `/products/${p.slug}`)).body.stockAlert, true);

  const inStock = await product('orbit-a14-4gb-ram-64gb');
  const refused = await call('PUT', `/stock-alerts/${inStock._id}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'This product is in stock: you can buy it now');
  assert.equal((await call('PUT', `/stock-alerts/${'0'.repeat(24)}`)).status, 404);
  assert.equal((await call('PUT', '/stock-alerts/nope')).status, 400);

  assert.deepEqual((await call('DELETE', `/stock-alerts/${p._id}`)).body, { stockAlert: false });
  assert.equal((await call('GET', `/products/${p.slug}`)).body.stockAlert, false);
});

test('everyone waiting is emailed once when the product is back in stock', async () => {
  const slug = SOLD_OUT[1];
  const p = await product(slug);
  const [a, b] = [await register(), await register()];
  for (const call of [a, b]) await call('PUT', `/stock-alerts/${p._id}`);

  assert.equal(await sendBackInStockAlerts(t.ctx), 0); // still sold out
  await restock(slug, 3);
  assert.equal(await sendBackInStockAlerts(t.ctx), 2);

  const [mail, ...more] = mailsTo(a);
  assert.equal(more.length, 0);
  assert.equal(mail.subject, `Back in stock: ${p.title}`);
  assert.match(mail.text, /^Hi Kavya,/);
  assert.match(mail.text, /is back in stock at ₹1,899/);
  assert.match(mail.text, /Only 3 left/);
  assert.match(mail.text, new RegExp(`https://bazaar.test/p/${slug}`));
  assert.equal(mailsTo(b).length, 1);

  // The alerts are used up: nothing more is sent.
  assert.equal(await alerts.countDocuments({ productId: p._id }), 0);
  assert.equal(await sendBackInStockAlerts(t.ctx), 0);
});

test('a hidden product waits until it is shown, and a failed email is retried', async () => {
  const slug = SOLD_OUT[2];
  const p = await product(slug);
  const call = await register();
  await call('PUT', `/stock-alerts/${p._id}`);
  await products.updateOne({ slug }, { $set: { stock: 20, active: false } });
  assert.equal(await sendBackInStockAlerts(t.ctx), 0);

  await products.updateOne({ slug }, { $set: { active: true } });
  t.mail.failNext();
  assert.equal(await sendBackInStockAlerts(t.ctx), 0);
  assert.equal(await alerts.countDocuments({ productId: p._id, sentAt: { $exists: false } }), 1); // kept for a retry
  assert.equal(await sendBackInStockAlerts(t.ctx), 1);
  assert.doesNotMatch(mailsTo(call)[0].text, /left/); // plenty in stock
});

test('stock returned by a cancelled order also sends the alert', async () => {
  const slug = SOLD_OUT[3];
  await restock(slug, 1);
  const p = await product(slug);
  const buyer = await register();
  const order = await buyer('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty: 1 }],
    address: {
      name: 'K M',
      phone: '9876543210',
      line1: '1 Main Rd',
      city: 'Kochi',
      state: 'Kerala',
      pincode: '682001',
    },
    expectedTotal: p.price + 4000, // ₹40 delivery below ₹499
  });
  assert.equal(order.status, 201);
  assert.equal((await product(slug)).stock, 0);

  const waiter = await register();
  await waiter('PUT', `/stock-alerts/${p._id}`);
  await buyer('POST', `/orders/${order.body.id}/cancel`);
  assert.equal(await sendBackInStockAlerts(t.ctx), 1);
  assert.equal(mailsTo(waiter).length, 1);
});

test('a customer can wait for at most 50 products', async () => {
  const call = await register();
  const user = await t.db.collection('users').findOne({ email: call.email });
  const fake = Array.from({ length: 50 }, (_, i) => ({ userId: user._id, productId: `x${i}`, createdAt: new Date() }));
  await alerts.insertMany(fake);
  await restock('ferro-chromebook-11', 0);
  const p = await product('ferro-chromebook-11');
  const res = await call('PUT', `/stock-alerts/${p._id}`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'You can have 50 stock alerts at a time. Cancel one first');
  await alerts.deleteMany({ userId: user._id });
});

// The sample shoes' sizes (UK 7–10); each test empties the sizes it watches.
const SHOES = 'stride-running-shoes';
const sizeOf = (doc, label) => doc.variants.find((v) => v.label === label);
// Sets one size's stock, keeping the product's total in step (as orders and admin edits do).
async function setSizeStock(label, stock) {
  const doc = await product(SHOES);
  const v = sizeOf(doc, label);
  await products.updateOne(
    { _id: doc._id, 'variants._id': v._id },
    { $set: { 'variants.$.stock': stock }, $inc: { stock: stock - v.stock } },
  );
}

test('a sold-out size can be watched while other sizes are in stock, and is emailed by name when back', async () => {
  await setSizeStock('UK 10', 0);
  await setSizeStock('UK 9', 0);
  const shoes = await product(SHOES);
  const [uk10, uk9, uk8] = [sizeOf(shoes, 'UK 10'), sizeOf(shoes, 'UK 9'), sizeOf(shoes, 'UK 8')];
  const call = await register();

  // In-stock size, unknown size, or the whole (in-stock) product: refused.
  const inStock = await call('PUT', `/stock-alerts/${shoes._id}?variant=${uk8._id}`);
  assert.equal(inStock.status, 409);
  assert.equal(inStock.body.error, 'This size is in stock: you can buy it now');
  assert.equal((await call('PUT', `/stock-alerts/${shoes._id}?variant=${'0'.repeat(24)}`)).status, 404);
  assert.equal((await call('PUT', `/stock-alerts/${shoes._id}?variant=nope`)).status, 400);
  assert.equal((await call('PUT', `/stock-alerts/${shoes._id}`)).status, 409);

  // Two sizes of one product at once.
  assert.deepEqual((await call('PUT', `/stock-alerts/${shoes._id}?variant=${uk10._id}`)).body, { stockAlert: true });
  assert.deepEqual((await call('PUT', `/stock-alerts/${shoes._id}?variant=${uk9._id}`)).body, { stockAlert: true });
  const page = (await call('GET', `/products/${SHOES}`)).body;
  assert.equal(page.stockAlert, false);
  assert.deepEqual(page.stockAlertVariants.sort(), [uk10._id.toString(), uk9._id.toString()].sort());

  // Other sizes selling or coming back don't send anything; only the size asked about does.
  await setSizeStock('UK 8', 25);
  await sendBackInStockAlerts(t.ctx);
  assert.equal(mailsTo(call).length, 0);

  await setSizeStock('UK 10', 3);
  await sendBackInStockAlerts(t.ctx);
  const [mail, ...more] = mailsTo(call);
  assert.equal(more.length, 0);
  assert.equal(mail.subject, 'Back in stock: Stride Running Shoes (Size: UK 10)');
  assert.match(mail.text, /Stride Running Shoes \(Size: UK 10\) is back in stock at ₹2,499/);
  assert.match(mail.text, /Only 3 left/);
  // UK 9 still waits.
  assert.deepEqual((await call('GET', `/products/${SHOES}`)).body.stockAlertVariants, [uk9._id.toString()]);

  // Cancelling one size leaves the others.
  assert.deepEqual((await call('DELETE', `/stock-alerts/${shoes._id}?variant=${uk9._id}`)).body, {
    stockAlert: false,
  });
  assert.deepEqual((await call('GET', `/products/${SHOES}`)).body.stockAlertVariants, []);
  await setSizeStock('UK 9', 10);
  await setSizeStock('UK 10', 5);
});

test('an alert for a size that is later deleted is dropped without an email', async () => {
  await setSizeStock('UK 7', 0);
  const shoes = await product(SHOES);
  const uk7 = sizeOf(shoes, 'UK 7');
  const call = await register();
  assert.equal((await call('PUT', `/stock-alerts/${shoes._id}?variant=${uk7._id}`)).status, 200);

  await products.updateOne({ _id: shoes._id }, { $pull: { variants: { _id: uk7._id } } });
  await sendBackInStockAlerts(t.ctx);
  assert.equal(mailsTo(call).length, 0);
  assert.equal(await alerts.countDocuments({ variantId: uk7._id }), 0);
});

test('starting up replaces the old one-alert-per-product index (as on databases from before sizes)', async () => {
  await alerts.dropIndex('userId_1_productId_1_variantId_1');
  await alerts.createIndex({ userId: 1, productId: 1 }, { unique: true });
  await ensureIndexes(t.db);
  const names = (await alerts.indexes()).map((i) => i.name);
  assert.ok(!names.includes('userId_1_productId_1'), names.join());
  assert.ok(names.includes('userId_1_productId_1_variantId_1'), names.join());
  // And running it again (every restart) is fine.
  await ensureIndexes(t.db);
});
