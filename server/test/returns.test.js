import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { returnRefund } from '../src/routes/returns.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
before(async () => {
  t = await startTestServer({ razorpay: true });
  admin = await register('admin@example.com', 'Store Admin');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
});
after(() => t.stop());

let n = 0;
async function register(email = `returner${++n}@example.com`, name = 'Asha Rao') {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name, email, password: 'password123' });
  assert.equal(res.status, 201);
  call.email = email;
  return call;
}

const BOOK = 'the-quiet-engineer-paperback'; // ₹349
const PHONE = 'orbit-a14-4gb-ram-64gb'; // ₹8,999
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
const product = (slug) => t.db.collection('products').findOne({ slug });

// A delivered order of `lines` ([slug, qty]…), paid by COD or online (through the stand-in Razorpay).
async function deliveredOrder(call, lines, { online = false, couponCode } = {}) {
  const items = [];
  for (const [slug, qty] of lines) items.push({ productId: (await product(slug))._id.toString(), qty });
  const quote = await call(
    'GET',
    `/cart?items=${items.map((i) => `${i.productId}:${i.qty}`).join(',')}${couponCode ? `&coupon=${couponCode}` : ''}`,
  );
  const res = await call('POST', '/orders', {
    items,
    address,
    expectedTotal: quote.body.total,
    paymentMethod: online ? 'razorpay' : 'cod',
    ...(couponCode && { couponCode }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  let order = res.body;
  if (online) {
    const { response } = t.fake.pay(order.payment.razorpayOrderId);
    order = (await call('POST', `/orders/${order.id}/payment`, response)).body;
  }
  for (const status of ['shipped', 'delivered']) {
    assert.equal((await admin('POST', `/admin/orders/${order.id}/status`, { status })).status, 200);
  }
  return (await call('GET', `/orders/${order.id}`)).body;
}
const ask = (call, order, items, reason = 'damaged', note = '') =>
  call('POST', `/orders/${order.id}/returns`, { items, reason, note });
const mailTo = (email, subject) => t.mail.sent.findLast((m) => m.to.email === email && m.subject.startsWith(subject));

test('only delivered orders, within 7 days, by their own customer, and each item at most as many times as bought', async () => {
  const call = await register();
  const book = await product(BOOK);
  const quote = await call('GET', `/cart?items=${book._id}:2`);
  const placed = (
    await call('POST', '/orders', {
      items: [{ productId: book._id.toString(), qty: 2 }],
      address,
      expectedTotal: quote.body.total,
    })
  ).body;
  assert.equal((await ask(call, placed, [{ index: 0, qty: 1 }])).status, 409);
  assert.equal((await call('GET', `/orders/${placed.id}/returns`)).body.canReturn, false);

  const order = await deliveredOrder(call, [[BOOK, 2]]);
  const info = (await call('GET', `/orders/${order.id}/returns`)).body;
  assert.equal(info.canReturn, true);
  assert.equal(new Date(info.returnableUntil) - new Date(order.deliveredAt), 7 * 86_400_000);
  assert.deepEqual(
    info.items.map((i) => [i.index, i.qty, i.returnable]),
    [[0, 2, 2]],
  );

  // Validation, other people's orders, too many.
  for (const [items, reason] of [
    [[], 'damaged'],
    [[{ index: 0, qty: 1 }], 'bored'],
    [[{ index: 0, qty: 0 }], 'damaged'],
    [
      [
        { index: 0, qty: 1 },
        { index: 0, qty: 1 },
      ],
      'damaged',
    ],
  ]) {
    assert.equal((await ask(call, order, items, reason)).status, 400, JSON.stringify(items));
  }
  assert.equal((await ask(call, order, [{ index: 5, qty: 1 }])).status, 400);
  assert.equal((await ask(await register(), order, [{ index: 0, qty: 1 }])).status, 404);
  assert.equal(
    (await t.call('POST', `/orders/${order.id}/returns`, { items: [{ index: 0, qty: 1 }], reason: 'damaged' })).status,
    401,
  );
  const tooMany = await ask(call, order, [{ index: 0, qty: 3 }]);
  assert.equal(tooMany.status, 409);
  assert.equal(tooMany.body.error, 'Only 2 of The Quiet Engineer (Paperback) can be returned');

  const first = await ask(call, order, [{ index: 0, qty: 1 }], 'damaged', 'Cover torn');
  assert.equal(first.status, 201);
  assert.equal(first.body.status, 'requested');
  assert.equal(first.body.refund, 34900);
  assert.equal(first.body.reasonText, 'Arrived damaged or faulty');
  assert.equal((await call('GET', `/orders/${order.id}/returns`)).body.items[0].returnable, 1);
  // The admins hear about it.
  const alert = mailTo('admin@example.com', `Return requested for order #${order.number}`);
  assert.match(alert.text, /Reason: Arrived damaged or faulty: Cover torn/);

  // Two requests at once for the last copy: only one gets it.
  const both = await Promise.all([ask(call, order, [{ index: 0, qty: 1 }]), ask(call, order, [{ index: 0, qty: 1 }])]);
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
  const none = await ask(call, order, [{ index: 0, qty: 1 }]);
  assert.equal(none.body.error, 'The Quiet Engineer (Paperback) is already being returned or exchanged');

  // After 7 days, no more.
  const late = await deliveredOrder(call, [[BOOK, 1]]);
  await t.db
    .collection('orders')
    .updateOne({ number: late.number }, { $set: { deliveredAt: new Date(Date.now() - 8 * 86_400_000) } });
  const tooLate = await ask(call, late, [{ index: 0, qty: 1 }]);
  assert.equal(tooLate.status, 409);
  assert.equal(tooLate.body.error, 'Returns are accepted for 7 days after delivery');
});

test("the refund is the items' price less their share of a coupon, never the delivery, and never more than was paid", () => {
  const order = {
    subtotal: 100_000,
    delivery: 4000,
    discount: 10_000,
    coupon: { type: 'flat' },
    items: [{ price: 30_000 }, { price: 70_000 }],
  };
  assert.equal(returnRefund(order, [{ index: 0, qty: 1 }]), 27_000);
  assert.equal(returnRefund(order, [{ index: 1, qty: 1 }], 27_000), 63_000);
  // Both together come to what was paid for the items.
  assert.equal(
    returnRefund(order, [{ index: 0, qty: 1 }]) + returnRefund(order, [{ index: 1, qty: 1 }], 27_000),
    90_000,
  );
  // A free-delivery coupon's discount was the delivery: nothing comes off the items.
  assert.equal(
    returnRefund({ ...order, discount: 4000, coupon: { type: 'free_delivery' } }, [{ index: 0, qty: 1 }]),
    30_000,
  );
  // Rounding can't take the total past what was paid.
  const thirds = {
    subtotal: 300,
    delivery: 0,
    discount: 100,
    coupon: { type: 'flat' },
    items: [{ price: 100 }, { price: 100 }, { price: 100 }],
  };
  const a = returnRefund(thirds, [{ index: 0, qty: 1 }]);
  const b = returnRefund(thirds, [{ index: 1, qty: 1 }], a);
  assert.equal(a + b + returnRefund(thirds, [{ index: 2, qty: 1 }], a + b), 200);
});

test('approving a COD return puts the stock back; the admin then marks it refunded. Declining says why', async () => {
  const call = await register();
  const order = await deliveredOrder(call, [
    [BOOK, 1],
    [PHONE, 1],
  ]);
  const stock = (await product(PHONE)).stock;
  const ret = (await ask(call, order, [{ index: 1, qty: 1 }], 'changed_mind')).body;
  assert.equal(ret.refundMethod, 'manual');
  assert.equal(ret.refund, 899_900);

  // Customers can't decide.
  assert.equal((await call('POST', `/admin/returns/${ret.id}/approve`)).status, 403);
  const list = await admin('GET', '/admin/returns?status=requested');
  const row = list.body.items.find((r) => r.id === ret.id);
  assert.deepEqual(row.customer, { name: 'Asha Rao', email: call.email });
  assert.ok(list.body.counts.requested >= 1);

  const approved = await admin('POST', `/admin/returns/${ret.id}/approve`);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'approved');
  assert.equal((await product(PHONE)).stock, stock + 1);
  assert.match(mailTo(call.email, 'Your return for order').text, /we'll refund ₹8,999 to you directly/);
  assert.equal((await admin('POST', `/admin/returns/${ret.id}/approve`)).status, 409);

  const done = await admin('POST', `/admin/returns/${ret.id}/refunded`);
  assert.equal(done.body.status, 'refunded');
  assert.equal((await call('GET', `/orders/${order.id}/returns`)).body.returns[0].status, 'refunded');

  // Declined: nothing comes back, and the customer may ask again for that item.
  const other = (await ask(call, order, [{ index: 0, qty: 1 }])).body;
  assert.equal((await admin('POST', `/admin/returns/${other.id}/decline`, {})).status, 400);
  const declined = await admin('POST', `/admin/returns/${other.id}/decline`, { reason: 'Used and marked' });
  assert.equal(declined.body.status, 'declined');
  const mail = mailTo(call.email, `Your return for order #${order.number} was declined`);
  assert.match(mail.text, /Why: Used and marked/);
  assert.equal((await call('GET', `/orders/${order.id}/returns`)).body.items[0].returnable, 1);
  assert.equal((await admin('POST', `/admin/returns/${other.id}/approve`)).status, 409);
});

test('an approved online return is refunded through Razorpay for just those items; a failed refund can be retried', async () => {
  const call = await register();
  const order = await deliveredOrder(call, [[BOOK, 2]], { online: true });
  const ret = (await ask(call, order, [{ index: 0, qty: 1 }])).body;
  assert.equal(ret.refundMethod, 'razorpay');

  const approved = await admin('POST', `/admin/returns/${ret.id}/approve`);
  assert.equal(approved.body.status, 'refunded');
  const refund = t.fake.state.refunds.at(-1);
  assert.equal(refund.amount, 34_900);
  assert.equal(refund.payment_id, order.payment.razorpayPaymentId);
  assert.match(
    mailTo(call.email, 'Your return for order').text,
    /started a refund of ₹349 to your original payment method/,
  );

  // The second copy: Razorpay refuses at first, then the admin retries.
  const second = (await ask(call, order, [{ index: 0, qty: 1 }])).body;
  t.fake.failNext('POST /v1/payments');
  const failed = await admin('POST', `/admin/returns/${second.id}/approve`);
  assert.equal(failed.body.status, 'refund_failed');
  assert.ok(failed.body.refundError);
  const retried = await admin('POST', `/admin/returns/${second.id}/refund`);
  assert.equal(retried.body.status, 'refunded');
  assert.equal(t.fake.state.refunds.at(-1).amount, 34_900);
  // An online return can't be "marked refunded" by hand, and a done one can't be retried.
  assert.equal((await admin('POST', `/admin/returns/${second.id}/refunded`)).status, 409);
  assert.equal((await admin('POST', `/admin/returns/${second.id}/refund`)).status, 409);
});

test("a variant's stock comes back to that variant; the admin's order page lists the order's returns", async () => {
  const call = await register();
  const shoes = await product('stride-running-shoes');
  const uk9 = shoes.variants.find((v) => v.label === 'UK 9');
  const items = [{ productId: shoes._id.toString(), variantId: uk9._id.toString(), qty: 1 }];
  const quote = await call('GET', `/cart?items=${shoes._id}.${uk9._id}:1`);
  let order = (await call('POST', '/orders', { items, address, expectedTotal: quote.body.total })).body;
  for (const status of ['shipped', 'delivered']) await admin('POST', `/admin/orders/${order.id}/status`, { status });
  order = (await call('GET', `/orders/${order.id}`)).body;

  const ret = (await ask(call, order, [{ index: 0, qty: 1 }], 'wrong_item')).body;
  const before = await product('stride-running-shoes');
  await admin('POST', `/admin/returns/${ret.id}/approve`);
  const after = await product('stride-running-shoes');
  assert.equal(
    after.variants.find((v) => v.label === 'UK 9').stock,
    before.variants.find((v) => v.label === 'UK 9').stock + 1,
  );
  assert.equal(after.stock, before.stock + 1);

  const forOrder = await admin('GET', `/admin/orders/${order.id}/returns`);
  assert.deepEqual(
    forOrder.body.map((r) => r.id),
    [ret.id],
  );
  assert.equal((await call('GET', `/admin/orders/${order.id}/returns`)).status, 403);
});
