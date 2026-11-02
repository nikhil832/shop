import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let buyer;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'Store Admin');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  buyer = await register('buyer@example.com', 'Asha Rao');
});
after(() => t.stop());
beforeEach(() => t.db.collection('settings').deleteOne({ _id: 'freeGift' }));

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}

const BOOK = 'the-quiet-engineer-paperback'; // ₹349
const PHONE = 'orbit-a14-4gb-ram-64gb'; // ₹8,999
const GIFT = 'learning-to-code-with-javascript';
const SHOES = 'stride-running-shoes'; // has sizes
const product = (slug) => t.db.collection('products').findOne({ slug });
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
const quote = async (call, slug, qty = 1) =>
  (await call('GET', `/cart?items=${(await product(slug))._id}:${qty}`)).body;
async function order(call, slug, qty = 1) {
  const p = await product(slug);
  const q = await quote(call, slug, qty);
  const res = await call('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty }],
    address,
    expectedTotal: q.total,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
async function switchOn(extra = {}) {
  const gift = await product(GIFT);
  const res = await admin('PUT', '/admin/free-gift', {
    enabled: true,
    productId: gift._id.toString(),
    minSubtotal: 99900,
    from: null,
    to: null,
    ...extra,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return gift;
}

test('off by default: no offer in the quote and no gift in orders', async () => {
  const settings = (await admin('GET', '/admin/free-gift')).body;
  assert.equal(settings.enabled, false);
  assert.equal(settings.live, false);
  assert.ok(settings.choices.some((c) => c.title.startsWith('Learning to Code')));
  // Products with options can't be gifts.
  assert.ok(!settings.choices.some((c) => c.title.startsWith('Stride Running Shoes')));
  assert.equal((await quote(buyer, PHONE)).freeGift, null);
  const placed = await order(buyer, PHONE);
  assert.equal(placed.items.length, 1);
});

test('the quote says how far the cart is from the gift; orders over the amount get it free', async () => {
  const gift = await switchOn();
  const small = await quote(buyer, BOOK);
  assert.equal(small.freeGift.product.slug, GIFT);
  assert.equal(small.freeGift.minSubtotal, 99900);
  assert.equal(small.freeGift.short, 99900 - 34900);
  assert.equal((await quote(t.call, PHONE)).freeGift.short, 0); // guests too

  // Below the amount: no gift.
  const book = await order(buyer, BOOK);
  assert.equal(book.items.length, 1);

  const before = (await product(GIFT)).stock;
  const q = await quote(buyer, PHONE);
  const placed = await order(buyer, PHONE);
  assert.equal(placed.total, q.total);
  assert.equal(placed.items.length, 2);
  const item = placed.items.find((i) => i.freeGift);
  assert.equal(item.productId, gift._id.toString());
  assert.equal(item.price, 0);
  assert.equal(item.qty, 1);
  assert.equal(item.regularPrice, gift.price);
  assert.match(item.title, / \(free gift\)$/);
  assert.equal(item.cost, undefined);
  assert.equal((await product(GIFT)).stock, before - 1);
  const history = await t.db.collection('stockHistory').findOne({ productId: gift._id, orderNumber: placed.number });
  assert.equal(history.change, -1);
  assert.equal(history.reason, 'ordered');

  // Cancelling the order gives the gift's stock back with the rest.
  assert.equal((await buyer('POST', `/orders/${placed.id}/cancel`, {})).status, 200);
  assert.equal((await product(GIFT)).stock, before);

  const settings = (await admin('GET', '/admin/free-gift')).body;
  assert.equal(settings.live, true);
  assert.equal(settings.given, 0); // the only gift went with a cancelled order
  const log = await t.db.collection('activity').findOne({ action: 'Changed the free gift' });
  assert.ok(log.changes.some((c) => c.field === 'Free gift' && c.to === 'On'));
});

test('a sold-out gift is not offered, and orders go ahead without it', async () => {
  const gift = await switchOn();
  const stock = gift.stock;
  await t.db.collection('products').updateOne({ _id: gift._id }, { $set: { stock: 0 } });
  try {
    assert.equal((await quote(buyer, PHONE)).freeGift, null);
    const placed = await order(buyer, PHONE);
    assert.equal(placed.items.length, 1);
  } finally {
    await t.db.collection('products').updateOne({ _id: gift._id }, { $set: { stock } });
  }
});

test('the offer runs only on its days (India time)', async () => {
  await switchOn({ from: '2099-01-01', to: null });
  assert.equal((await quote(buyer, PHONE)).freeGift, null);
  assert.equal((await admin('GET', '/admin/free-gift')).body.live, false);
  await switchOn({ from: null, to: '2020-01-01' });
  assert.equal((await quote(buyer, PHONE)).freeGift, null);
  await switchOn({ from: '2020-01-01', to: '2099-12-31' });
  assert.ok((await quote(buyer, PHONE)).freeGift);
});

test('item cancellation cannot leave only the free gift', async () => {
  await switchOn();
  const placed = await order(buyer, PHONE);
  const paid = placed.items.findIndex((i) => !i.freeGift);
  const res = await buyer('POST', `/orders/${placed.id}/cancel-items`, { items: [{ index: paid, qty: 1 }] });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /cancel the whole order/);
});

test('what an admin may save', async () => {
  const shoes = await product(SHOES);
  const gift = await product(GIFT);
  for (const [body, error] of [
    [{ enabled: true, productId: null, minSubtotal: 99900, from: null, to: null }, 'Choose a product'],
    [{ enabled: true, productId: shoes._id.toString(), minSubtotal: 99900, from: null, to: null }, 'without options'],
    [{ enabled: true, productId: gift._id.toString(), minSubtotal: 99950, from: null, to: null }, 'whole rupees'],
    [{ enabled: true, productId: gift._id.toString(), minSubtotal: 0, from: null, to: null }, 'From ₹1'],
    [
      { enabled: true, productId: gift._id.toString(), minSubtotal: 99900, from: '2030-02-01', to: '2030-01-01' },
      'before the first',
    ],
    [{ enabled: true, productId: gift._id.toString(), minSubtotal: 99900, from: '2030-02-30', to: null }, 'real date'],
    [{ enabled: true, productId: '0123456789abcdef01234567', minSubtotal: 99900, from: null, to: null }, 'no longer'],
  ]) {
    const res = await admin('PUT', '/admin/free-gift', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.error.includes(error), `${res.body.error} / ${error}`);
  }
  // Off with no product is fine.
  assert.equal(
    (
      await admin('PUT', '/admin/free-gift', {
        enabled: false,
        productId: null,
        minSubtotal: 50000,
        from: null,
        to: null,
      })
    ).status,
    200,
  );
  assert.equal((await buyer('GET', '/admin/free-gift')).status, 403);
  assert.equal((await t.call('PUT', '/admin/free-gift', {})).status, 401);
});
