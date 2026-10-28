import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { expireUnpaidOrders } from '../src/routes/orders.js';
import { startTestServer } from './helpers.js';

let t;
let products;
let orders;
before(async () => {
  t = await startTestServer({ razorpay: true });
  products = t.db.collection('products');
  orders = t.db.collection('orders');
});
after(() => t.stop());

const PHONE = 'orbit-a14-4gb-ram-64gb'; // ₹8,999, stock 40
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
const stockOf = async (slug) => (await products.findOne({ slug })).stock;

async function loggedIn(email) {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name: 'Asha Rao', email, password: 'password123' });
  assert.equal(res.status, 201);
  return call;
}

async function onlineOrder(call, qty = 1) {
  const p = await products.findOne({ slug: PHONE });
  const res = await call('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty }],
    address,
    expectedTotal: p.price * qty,
    paymentMethod: 'razorpay',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

// The customer pays in Razorpay's window, and the browser reports Checkout's response.
async function payInBrowser(call, order, status = 'captured') {
  const { response } = t.fake.pay(order.payment.razorpayOrderId, status);
  return call('POST', `/orders/${order.id}/payment`, response);
}

let n = 0;
const nextEmail = () => `payer${++n}@example.com`;

test('offers online payment when Razorpay is configured', async () => {
  assert.deepEqual((await t.call('GET', '/payments/options')).body, {
    cod: true,
    codMax: null,
    codReason: null,
    online: true,
  });
});

test('an online order reserves stock and opens a Razorpay order for the exact total', async () => {
  const call = await loggedIn(nextEmail());
  const stock = await stockOf(PHONE);
  const order = await onlineOrder(call, 2);

  assert.equal(order.status, 'awaiting_payment');
  assert.equal(order.payment.method, 'razorpay');
  assert.equal(order.payment.status, 'pending');
  assert.match(order.payment.razorpayOrderId, /^order_/);
  const minutesLeft = (new Date(order.expiresAt) - Date.now()) / 60_000;
  assert.ok(minutesLeft > 29 && minutesLeft <= 30, String(minutesLeft));
  assert.equal(await stockOf(PHONE), stock - 2);

  assert.deepEqual(order.checkout, {
    keyId: 'rzp_test_fakekey000000',
    orderId: order.payment.razorpayOrderId,
    amount: 1799800,
    currency: 'INR',
    expiresAt: order.expiresAt,
    prefill: { name: 'Asha Rao', email: `payer${n}@example.com`, contact: '9876543210' },
  });
  const rzpOrder = t.fake.state.orders.get(order.payment.razorpayOrderId);
  assert.equal(rzpOrder.amount, 1799800);
  assert.equal(rzpOrder.currency, 'INR');
  assert.equal(rzpOrder.receipt, `order_${order.number}`);
});

test('a verified payment places the order, and reporting it again changes nothing', async () => {
  const call = await loggedIn(nextEmail());
  const order = await onlineOrder(call);
  const res = await payInBrowser(call, order);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'placed');
  assert.equal(res.body.payment.status, 'paid');
  assert.match(res.body.payment.razorpayPaymentId, /^pay_/);
  assert.ok(res.body.payment.paidAt);
  assert.equal(res.body.expiresAt, null);

  const doc = await orders.findOne({ number: order.number });
  const again = await call('POST', `/orders/${order.id}/payment`, {
    razorpay_order_id: order.payment.razorpayOrderId,
    razorpay_payment_id: doc.payment.razorpayPaymentId,
    razorpay_signature: t.fake.pay(order.payment.razorpayOrderId).response.razorpay_signature.replace(/./, '0'),
  });
  assert.equal(again.status, 400); // a forged signature never counts, even for a paid order
  assert.equal(
    (await call('GET', `/orders/${order.id}`)).body.payment.razorpayPaymentId,
    doc.payment.razorpayPaymentId,
  );
});

test('rejects forged or mismatched payment reports', async () => {
  const call = await loggedIn(nextEmail());
  const order = await onlineOrder(call);
  const other = await onlineOrder(call);
  const { response } = t.fake.pay(other.payment.razorpayOrderId);

  const forged = await call('POST', `/orders/${order.id}/payment`, { ...response, razorpay_signature: 'f'.repeat(64) });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error, 'The payment could not be verified');
  // A genuine payment for a different order doesn't pay this one.
  const swapped = await call('POST', `/orders/${order.id}/payment`, response);
  assert.equal(swapped.status, 400);
  assert.equal((await call('GET', `/orders/${order.id}`)).body.status, 'awaiting_payment');

  const stranger = await loggedIn(nextEmail());
  assert.equal((await stranger('POST', `/orders/${other.id}/payment`, response)).status, 404);
  assert.equal((await call('POST', `/orders/${order.id}/payment`, { razorpay_order_id: 'x' })).status, 400);
});

test('captures an authorized payment, and refuses a failed one', async () => {
  const call = await loggedIn(nextEmail());
  const order = await onlineOrder(call);
  const authorized = await payInBrowser(call, order, 'authorized');
  assert.equal(authorized.body.status, 'placed');
  assert.equal(t.fake.state.payments.get(authorized.body.payment.razorpayPaymentId).status, 'captured');

  const second = await onlineOrder(call);
  const failed = await payInBrowser(call, second, 'failed');
  assert.equal(failed.status, 400);
  assert.equal(failed.body.error, 'The payment did not go through. You can try again.');
  assert.equal((await call('GET', `/orders/${second.id}`)).body.status, 'awaiting_payment');
});

test('"check again" finds a payment the browser never reported', async () => {
  const call = await loggedIn(nextEmail());
  const order = await onlineOrder(call);
  const unpaid = await call('POST', `/orders/${order.id}/payment/check`);
  assert.equal(unpaid.body.status, 'awaiting_payment');

  t.fake.pay(order.payment.razorpayOrderId);
  const checked = await call('POST', `/orders/${order.id}/payment/check`);
  assert.equal(checked.body.status, 'placed');
  assert.equal(checked.body.payment.status, 'paid');
});

test('the webhook confirms payments, once, and only when correctly signed', async () => {
  const call = await loggedIn(nextEmail());
  const order = await onlineOrder(call);
  const { payment } = t.fake.pay(order.payment.razorpayOrderId);
  const { body, signature } = t.fake.webhook('payment.captured', payment);

  const bad = await t.webhook(body, 'a'.repeat(64));
  assert.equal(bad.status, 400);
  assert.equal((await call('GET', `/orders/${order.id}`)).body.status, 'awaiting_payment');

  for (let i = 0; i < 2; i++) {
    const res = await t.webhook(body, signature);
    assert.equal(res.status, 200);
  }
  const placed = (await call('GET', `/orders/${order.id}`)).body;
  assert.equal(placed.status, 'placed');
  assert.equal(placed.payment.razorpayPaymentId, payment.id);

  // Events we don't use, and payments for unknown orders, are acknowledged and ignored.
  const other = t.fake.webhook('payment.failed', payment);
  assert.equal((await t.webhook(other.body, other.signature)).status, 200);
  const stray = t.fake.webhook('payment.captured', { ...payment, order_id: 'order_unknown' });
  assert.equal((await t.webhook(stray.body, stray.signature)).status, 200);
});

test('cancelling a paid order refunds it in full and returns the stock', async () => {
  const call = await loggedIn(nextEmail());
  const stock = await stockOf(PHONE);
  const order = await onlineOrder(call, 2);
  await payInBrowser(call, order);

  const res = await call('POST', `/orders/${order.id}/cancel`);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'cancelled');
  assert.equal(res.body.payment.status, 'refunded');
  assert.match(res.body.payment.refundId, /^rfnd_/);
  assert.equal(await stockOf(PHONE), stock);
  const refund = t.fake.state.refunds.find((r) => r.id === res.body.payment.refundId);
  assert.equal(refund.amount, 1799800);
});

test('cancelling an unpaid order returns the stock without a refund', async () => {
  const call = await loggedIn(nextEmail());
  const stock = await stockOf(PHONE);
  const order = await onlineOrder(call);
  const refunds = t.fake.state.refunds.length;
  const res = await call('POST', `/orders/${order.id}/cancel`);
  assert.equal(res.body.status, 'cancelled');
  assert.equal(res.body.payment.status, 'pending');
  assert.equal(await stockOf(PHONE), stock);
  assert.equal(t.fake.state.refunds.length, refunds);
});

test('a failed refund is recorded, and an admin can retry it', async () => {
  const call = await loggedIn(nextEmail());
  const order = await onlineOrder(call);
  await payInBrowser(call, order);
  t.fake.failNext('POST /v1/payments');
  const res = await call('POST', `/orders/${order.id}/cancel`);
  assert.equal(res.body.status, 'cancelled');
  assert.equal(res.body.payment.status, 'refund_failed');
  // The customer sees the refund as in progress; why it failed is for admins only.
  assert.equal(res.body.payment.refundError, undefined);
  const stored = await t.db.collection('orders').findOne({ _id: new ObjectId(order.id) });
  assert.equal(
    stored.payment.refundError,
    'Razorpay refused the refund ("Simulated failure"). Check that your Razorpay balance covers ₹8,999, then retry.',
  );

  const admin = await loggedIn(nextEmail());
  await t.db.collection('users').updateOne({ email: `payer${n}@example.com` }, { $set: { role: 'admin' } });
  const seen = await admin('GET', `/admin/orders/${order.id}`);
  assert.equal(seen.body.payment.refundError, stored.payment.refundError);
  const retried = await admin('POST', `/admin/orders/${order.id}/refund`);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.payment.status, 'refunded');
  assert.equal(retried.body.payment.refundError, undefined);
  assert.equal((await admin('POST', `/admin/orders/${order.id}/refund`)).status, 409);
});

test('unpaid orders expire after the window and give their stock back', async () => {
  const call = await loggedIn(nextEmail());
  const stock = await stockOf(PHONE);
  const order = await onlineOrder(call, 3);
  await orders.updateOne({ number: order.number }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

  assert.ok((await expireUnpaidOrders(t.ctx)) >= 1);
  const expired = (await call('GET', `/orders/${order.id}`)).body;
  assert.equal(expired.status, 'cancelled');
  assert.equal(expired.cancelledBy, 'system');
  assert.equal(await stockOf(PHONE), stock);

  const reopen = await call('POST', `/orders/${order.id}/pay`);
  assert.equal(reopen.status, 409);
  assert.equal(reopen.body.error, 'The time to pay for this order has run out');
});

test('an order paid just before expiry is placed, not cancelled', async () => {
  const call = await loggedIn(nextEmail());
  const order = await onlineOrder(call);
  t.fake.pay(order.payment.razorpayOrderId); // paid, but the browser never reported it
  await orders.updateOne({ number: order.number }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  await expireUnpaidOrders(t.ctx);
  const doc = (await call('GET', `/orders/${order.id}`)).body;
  assert.equal(doc.status, 'placed');
  assert.equal(doc.payment.status, 'paid');
});

test('a payment arriving after the order was cancelled is refunded automatically', async () => {
  const call = await loggedIn(nextEmail());
  const order = await onlineOrder(call);
  await call('POST', `/orders/${order.id}/cancel`);
  const { payment } = t.fake.pay(order.payment.razorpayOrderId);
  const hook = t.fake.webhook('payment.captured', payment);
  assert.equal((await t.webhook(hook.body, hook.signature)).status, 200);
  const doc = (await call('GET', `/orders/${order.id}`)).body;
  assert.equal(doc.status, 'cancelled');
  assert.equal(doc.payment.status, 'refunded');
  assert.equal(t.fake.state.refunds.at(-1).payment_id, payment.id);
});

test('reopening payment returns the same Razorpay order until it is paid', async () => {
  const call = await loggedIn(nextEmail());
  const order = await onlineOrder(call);
  const reopen = await call('POST', `/orders/${order.id}/pay`);
  assert.equal(reopen.status, 200);
  assert.equal(reopen.body.checkout.orderId, order.payment.razorpayOrderId);
  await payInBrowser(call, order);
  const paid = await call('POST', `/orders/${order.id}/pay`);
  assert.equal(paid.status, 409);
  assert.equal(paid.body.error, 'This order is already paid');
});

test('if Razorpay is down, the order is not kept and its stock is returned', async () => {
  const call = await loggedIn(nextEmail());
  const stock = await stockOf(PHONE);
  const before = await orders.countDocuments({ status: 'awaiting_payment' });
  t.fake.failNext('POST /v1/orders');
  const p = await products.findOne({ slug: PHONE });
  const res = await call('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty: 1 }],
    address,
    expectedTotal: p.price,
    paymentMethod: 'razorpay',
  });
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'The payment service returned an error. Please try again.');
  assert.equal(await stockOf(PHONE), stock);
  assert.equal(await orders.countDocuments({ status: 'awaiting_payment' }), before);
});
