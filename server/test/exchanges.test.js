import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { startTestServer } from './helpers.js';

let t;
let admin;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'Store Admin');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
});
after(() => t.stop());

let n = 0;
async function register(email = `swapper${++n}@example.com`, name = 'Asha Rao') {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name, email, password: 'password123' });
  assert.equal(res.status, 201);
  call.email = email;
  return call;
}

const SHOES = 'stride-running-shoes'; // UK 7–10, all ₹2,499
const JEANS = 'urbane-men-slim-fit-jeans'; // Blue 30 (sold out), Blue 32, Blue 34 (₹1,299), Black 30, Black 32
const BOOK = 'the-quiet-engineer-paperback';
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
const product = (slug) => t.db.collection('products').findOne({ slug });
const variant = (p, label) => p.variants.find((v) => v.label === label);
const stockOf = async (slug, label) => variant(await product(slug), label).stock;

// A delivered COD order of `lines` ([slug, variant label or null, qty]…).
async function deliveredOrder(call, lines) {
  const items = [];
  for (const [slug, label, qty] of lines) {
    const p = await product(slug);
    items.push({ productId: p._id.toString(), ...(label && { variantId: variant(p, label)._id.toString() }), qty });
  }
  const quote = await call(
    'GET',
    `/cart?items=${items.map((i) => `${i.productId}${i.variantId ? `.${i.variantId}` : ''}:${i.qty}`).join(',')}`,
  );
  const res = await call('POST', '/orders', { items, address, expectedTotal: quote.body.total });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  for (const status of ['shipped', 'delivered']) {
    assert.equal((await admin('POST', `/admin/orders/${res.body.id}/status`, { status })).status, 200);
  }
  return (await call('GET', `/orders/${res.body.id}`)).body;
}
const ask = (call, order, items, reason = 'fit', note = '') =>
  call('POST', `/orders/${order.id}/exchanges`, { items, reason, note });
const mailTo = (email, subject) => t.mail.sent.findLast((m) => m.to.email === email && m.subject.startsWith(subject));

test('the options offered are the same product at the same price, in stock or not; lines without options get none', async () => {
  const call = await register();
  const order = await deliveredOrder(call, [
    [JEANS, 'Blue / 32', 1],
    [BOOK, null, 1],
  ]);
  const info = (await call('GET', `/orders/${order.id}/exchanges`)).body;
  assert.equal(info.canExchange, true);
  assert.equal(new Date(info.exchangeableUntil) - new Date(order.deliveredAt), 7 * 86_400_000);
  // Not Blue 34 (₹1,299), not the one bought; Blue 30 is offered but sold out.
  assert.deepEqual(
    info.items[0].options.map((o) => [o.label, o.stock > 0]),
    [
      ['Blue / 30', false],
      ['Black / 30', true],
      ['Black / 32', true],
    ],
  );
  assert.equal(info.items[0].exchangeable, 1);
  assert.deepEqual(info.items[1].options, []);
  assert.equal((await (await register())('GET', `/orders/${order.id}/exchanges`)).status, 404);
});

test('asking sets the new option aside; refusals for other prices, sold-out options, too many and returned items', async () => {
  const call = await register();
  const order = await deliveredOrder(call, [[SHOES, 'UK 8', 2]]);
  const shoes = await product(SHOES);
  const uk9 = variant(shoes, 'UK 9')._id.toString();

  // Validation.
  for (const body of [
    { items: [], reason: 'fit' },
    { items: [{ index: 0, qty: 1, variantId: uk9 }], reason: 'bored' },
    { items: [{ index: 0, qty: 1, variantId: 'nope' }], reason: 'fit' },
  ]) {
    assert.equal((await call('POST', `/orders/${order.id}/exchanges`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await ask(call, order, [{ index: 3, qty: 1, variantId: uk9 }])).status, 400);
  // The same option, another product's option, more than bought.
  const same = await ask(call, order, [{ index: 0, qty: 1, variantId: variant(shoes, 'UK 8')._id.toString() }]);
  assert.equal(same.status, 409);
  assert.equal(same.body.error, "Stride Running Shoes (Size: UK 8) can't be exchanged for that option");
  const jeans = await product(JEANS);
  assert.equal(
    (await ask(call, order, [{ index: 0, qty: 1, variantId: variant(jeans, 'Black / 32')._id.toString() }])).status,
    409,
  );
  assert.equal((await ask(call, order, [{ index: 0, qty: 3, variantId: uk9 }])).body.error.startsWith('Only 2'), true);

  // A size that is short: nothing changes.
  const uk10 = variant(shoes, 'UK 10');
  await t.db
    .collection('products')
    .updateOne({ _id: shoes._id, 'variants._id': uk10._id }, { $set: { 'variants.$.stock': 1 } });
  const short = await ask(call, order, [{ index: 0, qty: 2, variantId: uk10._id.toString() }]);
  assert.equal(short.status, 409);
  assert.equal(short.body.error, 'Only 1 of UK 10 are left');
  assert.equal(await t.db.collection('exchanges').countDocuments({ orderId: new ObjectId(order.id) }), 0);

  const before = await product(SHOES);
  const res = await ask(call, order, [{ index: 0, qty: 1, variantId: uk9 }], 'fit', 'Too tight');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.status, 'requested');
  assert.deepEqual(res.body.items, [
    {
      index: 0,
      productId: shoes._id.toString(),
      title: 'Stride Running Shoes',
      fromLabel: 'UK 8',
      toLabel: 'UK 9',
      toVariantId: uk9,
      qty: 1,
    },
  ]);
  assert.equal(res.body.reasonText, "Doesn't fit");
  const after = await product(SHOES);
  assert.equal(variant(after, 'UK 9').stock, variant(before, 'UK 9').stock - 1);
  assert.equal(after.stock, before.stock - 1);
  const entry = await t.db.collection('stockHistory').findOne({ exchangeId: { $exists: true } });
  assert.equal(entry.reason, 'exchange_reserved');
  assert.equal(entry.change, -1);
  assert.equal(entry.label, 'UK 9');
  assert.ok(mailTo('admin@example.com', `Exchange requested for order #${order.number}`));

  // One left: it can be returned but not exchanged twice; once returned, nothing is left for either.
  const info = (await call('GET', `/orders/${order.id}/exchanges`)).body;
  assert.equal(info.items[0].exchangeable, 1);
  assert.equal((await call('GET', `/orders/${order.id}/returns`)).body.items[0].returnable, 1);
  const ret = await call('POST', `/orders/${order.id}/returns`, { items: [{ index: 0, qty: 1 }], reason: 'damaged' });
  assert.equal(ret.status, 201);
  const none = await ask(call, order, [{ index: 0, qty: 1, variantId: uk9 }]);
  assert.equal(none.status, 409);
  assert.equal(none.body.error, 'Stride Running Shoes (Size: UK 8) is already being returned or exchanged');
  const noReturn = await call('POST', `/orders/${order.id}/returns`, {
    items: [{ index: 0, qty: 1 }],
    reason: 'damaged',
  });
  assert.equal(noReturn.status, 409);
});

test('only delivered orders within the return window; customers can call off a waiting exchange', async () => {
  const call = await register();
  const shoes = await product(SHOES);
  const uk7 = variant(shoes, 'UK 7');
  const quote = await call('GET', `/cart?items=${shoes._id}.${uk7._id}:1`);
  const placed = (
    await call('POST', '/orders', {
      items: [{ productId: shoes._id.toString(), variantId: uk7._id.toString(), qty: 1 }],
      address,
      expectedTotal: quote.body.total,
    })
  ).body;
  const uk10 = variant(shoes, 'UK 10')._id.toString();
  assert.equal((await ask(call, placed, [{ index: 0, qty: 1, variantId: uk10 }])).status, 409);
  assert.equal((await call('GET', `/orders/${placed.id}/exchanges`)).body.canExchange, false);

  const order = await deliveredOrder(call, [[SHOES, 'UK 7', 1]]);
  await t.db
    .collection('orders')
    .updateOne({ _id: new ObjectId(order.id) }, { $set: { deliveredAt: new Date(Date.now() - 8 * 86_400_000) } });
  const late = await ask(call, order, [{ index: 0, qty: 1, variantId: uk10 }]);
  assert.equal(late.status, 409);
  assert.equal(late.body.error, 'Exchanges are accepted for 7 days after delivery');
  await t.db.collection('orders').updateOne({ _id: new ObjectId(order.id) }, { $set: { deliveredAt: new Date() } });

  const before = await stockOf(SHOES, 'UK 10');
  const ex = (await ask(call, order, [{ index: 0, qty: 1, variantId: uk10 }])).body;
  assert.equal(await stockOf(SHOES, 'UK 10'), before - 1);
  // Someone else can't call it off.
  assert.equal((await (await register())('POST', `/orders/${order.id}/exchanges/${ex.id}/cancel`)).status, 404);
  const cancelled = await call('POST', `/orders/${order.id}/exchanges/${ex.id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(await stockOf(SHOES, 'UK 10'), before);
  assert.equal((await call('POST', `/orders/${order.id}/exchanges/${ex.id}/cancel`)).status, 409);
  // Called off: the item can be exchanged again.
  assert.equal((await call('GET', `/orders/${order.id}/exchanges`)).body.items[0].exchangeable, 1);
});

test('the admin approves once the item is back (its stock returns), ships the new one with tracking, then delivered', async () => {
  const call = await register();
  const order = await deliveredOrder(call, [[SHOES, 'UK 8', 1]]);
  const uk9 = variant(await product(SHOES), 'UK 9')._id.toString();
  const ex = (await ask(call, order, [{ index: 0, qty: 1, variantId: uk9 }])).body;

  assert.equal((await call('POST', `/admin/exchanges/${ex.id}/approve`)).status, 403);
  assert.equal((await t.call('GET', '/admin/exchanges')).status, 401);
  const list = (await admin('GET', '/admin/exchanges')).body;
  const row = list.items.find((x) => x.id === ex.id);
  assert.equal(row.customer.email, call.email);
  assert.ok(list.counts.requested >= 1);
  assert.ok((await admin('GET', '/admin/dashboard')).body.exchanges.toReview >= 1);
  // Shipping before approving, or delivering before shipping, is refused.
  assert.equal((await admin('POST', `/admin/exchanges/${ex.id}/ship`, {})).status, 409);
  assert.equal((await admin('POST', `/admin/exchanges/${ex.id}/delivered`)).status, 409);

  const uk8Before = await stockOf(SHOES, 'UK 8');
  const uk9Before = await stockOf(SHOES, 'UK 9');
  const approved = await admin('POST', `/admin/exchanges/${ex.id}/approve`);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'approved');
  assert.equal(await stockOf(SHOES, 'UK 8'), uk8Before + 1);
  assert.equal(await stockOf(SHOES, 'UK 9'), uk9Before);
  assert.equal(
    (await admin('POST', `/admin/exchanges/${ex.id}/approve`)).body.error,
    'This exchange is already approved',
  );
  assert.ok(mailTo(call.email, `Your exchange for order #${order.number} was approved`));
  assert.ok((await admin('GET', '/admin/dashboard')).body.exchanges.toShip >= 1);
  assert.equal((await call('POST', `/orders/${order.id}/exchanges/${ex.id}/cancel`)).status, 409);

  // Tracking is checked like an order's.
  const bad = await admin('POST', `/admin/exchanges/${ex.id}/ship`, {
    shipment: { courier: 'Delhivery', trackingNumber: 'AB1', trackingUrl: 'javascript:alert(1)' },
  });
  assert.equal(bad.status, 400);
  const shipped = await admin('POST', `/admin/exchanges/${ex.id}/ship`, {
    shipment: { courier: 'Delhivery', trackingNumber: 'DL123', trackingUrl: 'https://track.example/DL123' },
  });
  assert.equal(shipped.status, 200);
  assert.equal(shipped.body.status, 'shipped');
  assert.equal(shipped.body.shipment.trackingNumber, 'DL123');
  const mail = mailTo(call.email, `Your exchange for order #${order.number} is on its way`);
  assert.match(mail.text, /Stride Running Shoes: UK 8 → UK 9 × 1/);
  assert.match(mail.text, /Delhivery, tracking number DL123/);
  assert.match(mail.text, /Track your parcel: https:\/\/track.example\/DL123/);

  const delivered = await admin('POST', `/admin/exchanges/${ex.id}/delivered`);
  assert.equal(delivered.body.status, 'delivered');
  // The order and its totals are untouched; the exchange is listed on the admin's order page and in the log.
  const now = (await call('GET', `/orders/${order.id}`)).body;
  assert.equal(now.status, 'delivered');
  assert.equal(now.total, order.total);
  assert.deepEqual(
    (await admin('GET', `/admin/orders/${order.id}/exchanges`)).body.map((x) => x.status),
    ['delivered'],
  );
  const actions = (await t.db.collection('activity').find({ area: 'returns' }).toArray()).map((a) => a.action);
  for (const action of ['Approved exchange', 'Shipped exchange', 'Delivered exchange'])
    assert.ok(actions.includes(action));
  // Exchanged: nothing more to return or exchange from that line.
  assert.equal((await call('GET', `/orders/${order.id}/returns`)).body.items[0].returnable, 0);
});

test('declining gives the set-aside option back and tells the customer why', async () => {
  const call = await register();
  const order = await deliveredOrder(call, [[SHOES, 'UK 7', 1]]);
  const uk8 = variant(await product(SHOES), 'UK 8')._id.toString();
  const before = await stockOf(SHOES, 'UK 8');
  const ex = (await ask(call, order, [{ index: 0, qty: 1, variantId: uk8 }])).body;
  assert.equal((await admin('POST', `/admin/exchanges/${ex.id}/decline`, { reason: ' ' })).status, 400);
  const declined = await admin('POST', `/admin/exchanges/${ex.id}/decline`, { reason: 'The shoes were worn outside' });
  assert.equal(declined.status, 200);
  assert.equal(declined.body.declineReason, 'The shoes were worn outside');
  assert.equal(await stockOf(SHOES, 'UK 8'), before);
  const released = await t.db
    .collection('stockHistory')
    .findOne({ exchangeId: new ObjectId(ex.id), reason: 'exchange_released' });
  assert.equal(released.by.name, 'Store Admin');
  assert.match(mailTo(call.email, `Your exchange for order #${order.number} was declined`).text, /worn outside/);
});

test('an open exchange stops the account being closed, and is in the data download', async () => {
  const call = await register();
  const order = await deliveredOrder(call, [[SHOES, 'UK 7', 1]]);
  const uk8 = variant(await product(SHOES), 'UK 8')._id.toString();
  await ask(call, order, [{ index: 0, qty: 1, variantId: uk8 }]);
  const data = (await call('GET', '/account/data')).body;
  assert.deepEqual(
    data.exchanges.map((x) => x.items[0].toLabel),
    ['UK 8'],
  );
  const close = await call('POST', '/account/close', { password: 'password123', confirm: true });
  assert.equal(close.status, 409);
  assert.match(close.body.error, /exchange in progress/);
});
