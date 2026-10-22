import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
