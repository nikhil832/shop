import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { addCredit } from '../src/credit.js';
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
async function register(email = `buyer${++n}@example.com`, name = 'Asha Rao') {
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
const mailTo = (email, subject) => t.mail.sent.findLast((m) => m.to.email === email && m.subject.startsWith(subject));

// A placed order of `lines` ([slug, qty]…): COD, or online and paid through the stand-in Razorpay.
async function placed(call, lines, { online = false, couponCode, creditToUse = 0 } = {}) {
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
    creditToUse,
    ...(couponCode && { couponCode }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  let order = res.body;
  if (online) {
    const { response } = t.fake.pay(order.payment.razorpayOrderId);
    order = (await call('POST', `/orders/${order.id}/payment`, response)).body;
    assert.equal(order.status, 'placed');
  }
  return order;
}
const cancel = (call, order, items, preview = false) =>
  call('POST', `/orders/${order.id}/cancel-items`, { items, ...(preview && { preview }) });

test('a customer cancels some items of a COD order: stock back, totals worked out again, emails', async () => {
  const call = await register();
  const order = await placed(call, [
    [BOOK, 2],
    [PHONE, 1],
  ]);
  assert.equal(order.total, 969700); // free delivery
  const bookStock = (await product(BOOK)).stock;

  const preview = await cancel(call, order, [{ index: 0, qty: 1 }], true);
  assert.deepEqual(preview.body, {
    preview: { total: 934800, amount: 34900, refund: 0, creditBack: 0, toCollect: 934800 },
  });
  assert.equal((await product(BOOK)).stock, bookStock); // a preview changes nothing

  const res = await cancel(call, order, [{ index: 0, qty: 1 }]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.total, 934800);
  assert.equal(res.body.subtotal, 934800);
  assert.deepEqual(
    res.body.items.map((i) => [i.title, i.qty]),
    [
      ['The Quiet Engineer (Paperback)', 1],
      ['Orbit A14 (4GB RAM, 64GB)', 1],
    ],
  );
  const [entry] = res.body.cancellations;
  assert.equal(entry.amount, 34900);
  assert.equal(entry.refundStatus, 'none');
  assert.equal(entry.role, 'customer');
  assert.equal(entry.by, undefined); // admins only
  assert.equal(entry.items[0].qty, 1);
  assert.equal((await product(BOOK)).stock, bookStock + 1);
  const history = await t.db
    .collection('stockHistory')
    .findOne({ orderId: new ObjectId(order.id), reason: 'cancelled' });
  assert.equal(history.change, 1);

  const mail = mailTo(call.email, 'Items cancelled from order');
  assert.match(mail.text, /You cancelled these items/);
  assert.match(mail.text, /The Quiet Engineer \(Paperback\) × 1/);
  assert.match(mail.text, /total is now ₹9,348/);
  assert.match(mail.text, /You'll pay ₹9,348 on delivery/);
  assert.ok(mailTo('admin@example.com', `Order #${order.number}: items cancelled`));

  // The phone's whole line goes; the delivery charge stays as it was (free), though the rest is under ₹499 now.
  const second = await cancel(call, order, [{ index: 1, qty: 1 }]);
  assert.equal(second.body.items.length, 1);
  assert.equal(second.body.total, 34900);
  assert.equal(second.body.delivery, 0);
  assert.equal(second.body.cancellations.length, 2);

  // The last unit: cancel the whole order instead.
  assert.equal((await cancel(call, order, [{ index: 0, qty: 1 }])).status, 409);
});

test('only the order’s customer, only placed orders, only items that are there', async () => {
  const call = await register();
  const order = await placed(call, [[BOOK, 2]]);
  assert.equal((await cancel(t.call, order, [{ index: 0, qty: 1 }])).status, 401);
  assert.equal((await cancel(await register(), order, [{ index: 0, qty: 1 }])).status, 404);
  assert.equal((await cancel(call, order, [{ index: 3, qty: 1 }])).status, 400);
  assert.equal((await cancel(call, order, [{ index: 0, qty: 3 }])).status, 409);
  assert.equal((await cancel(call, order, [])).status, 400);
  assert.equal(
    (
      await cancel(call, order, [
        { index: 0, qty: 1 },
        { index: 0, qty: 1 },
      ])
    ).status,
    400,
  );
  assert.equal((await admin('POST', `/admin/orders/${order.id}/status`, { status: 'shipped' })).status, 200);
  const shipped = await cancel(call, order, [{ index: 0, qty: 1 }]);
  assert.equal(shipped.status, 409);
  assert.match(shipped.body.error, /before the order ships/);
});

test('a paid online order gets a part refund; a failed one is retried by an admin; the rest refunds on cancel', async () => {
  const call = await register();
  const order = await placed(
    call,
    [
      [BOOK, 2],
      [PHONE, 1],
    ],
    { online: true },
  );
  const paymentId = (await t.db.collection('orders').findOne({ _id: new ObjectId(order.id) })).payment
    .razorpayPaymentId;
  const refunds = () => t.fake.state.refunds.filter((r) => r.payment_id === paymentId).map((r) => r.amount);

  const res = await cancel(call, order, [{ index: 1, qty: 1 }]);
  assert.equal(res.body.total, 69800);
  assert.equal(res.body.cancellations[0].refund, 899900);
  assert.equal(res.body.cancellations[0].refundStatus, 'refunded');
  assert.equal(res.body.payment.status, 'paid'); // still paid for the rest
  assert.deepEqual(refunds(), [899900]);
  assert.match(mailTo(call.email, 'Items cancelled').text, /started a refund of ₹8,999/);

  t.fake.failNext('POST /v1/payments');
  const failed = await cancel(call, order, [{ index: 0, qty: 1 }]);
  const entry = failed.body.cancellations[1];
  assert.equal(entry.refundStatus, 'refund_failed');
  assert.match(mailTo(call.email, 'Items cancelled').text, /We'll refund ₹349 to the way you paid shortly/);
  const retryPath = `/admin/orders/${order.id}/cancellations/${entry.id}/refund`;
  assert.equal((await call('POST', retryPath)).status, 403);
  const adminView = (await admin('GET', `/admin/orders/${order.id}`)).body;
  assert.ok(adminView.cancellations[1].refundError);
  const retried = await admin('POST', retryPath);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.cancellations[1].refundStatus, 'refunded');
  assert.equal((await admin('POST', retryPath)).status, 409);

  // Cancelling the rest refunds what's left: everything paid comes back once.
  assert.equal((await call('POST', `/orders/${order.id}/cancel`)).status, 200);
  assert.deepEqual(refunds(), [899900, 34900, 34900]);
  assert.equal(
    refunds().reduce((a, b) => a + b, 0),
    order.total,
  );
});

test('a coupon’s discount shrinks by the cancelled share; store credit comes back beyond the new total', async () => {
  assert.equal((await admin('POST', '/admin/coupons', { code: 'CANCEL10', type: 'percent', value: 10 })).status, 201);
  const call = await register();
  const user = await t.db.collection('users').findOne({ email: call.email });
  await addCredit(t.db, user._id, 10000, { reason: 'goodwill', by: null });
  const order = await placed(
    call,
    [
      [BOOK, 2],
      [PHONE, 1],
    ],
    { couponCode: 'CANCEL10', creditToUse: 10000 },
  );
  assert.equal(order.discount, 96900); // 10% of ₹9,697, whole rupees
  const res = await cancel(call, order, [{ index: 1, qty: 1 }]);
  // The phone's share of ₹969 is ₹899: ₹70 off the books stays.
  assert.equal(res.body.discount, 7000);
  assert.equal(res.body.total, 69800 - 7000);
  assert.equal(res.body.creditUsed, 10000); // still within the new total
  assert.equal(res.body.cancellations[0].creditBack, 0);
  // The GST-free order's bill still adds up.
  assert.equal(res.body.subtotal + res.body.delivery - res.body.discount, res.body.total);

  // Credit larger than what's left: the rest goes back to the account.
  const rich = await register();
  const richUser = await t.db.collection('users').findOne({ email: rich.email });
  await addCredit(t.db, richUser._id, 50000, { reason: 'goodwill', by: null });
  const small = await placed(rich, [[BOOK, 2]], { creditToUse: 50000 });
  const back = await cancel(rich, small, [{ index: 0, qty: 1 }]);
  assert.equal(back.body.total, 34900);
  assert.equal(back.body.creditUsed, 34900);
  assert.equal(back.body.cancellations[0].creditBack, 15100);
  assert.equal((await t.db.collection('users').findOne({ _id: richUser._id })).credit, 15100);
  const ledger = await t.db.collection('creditLedger').findOne({ userId: richUser._id, reason: 'cancelled' });
  assert.equal(ledger.change, 15100);
  assert.match(mailTo(rich.email, 'Items cancelled').text, /₹151 is back in your store credit/);
});

test('admins cancel items too: logged, the customer told, no alert to admins', async () => {
  const call = await register();
  const order = await placed(call, [[BOOK, 3]]); // ₹1,047, free delivery
  const alerts = () => t.mail.sent.filter((m) => m.subject === `Order #${order.number}: items cancelled`).length;
  const path = `/admin/orders/${order.id}/cancel-items`;
  assert.equal((await call('POST', path, { items: [{ index: 0, qty: 1 }] })).status, 403);
  const preview = await admin('POST', path, { items: [{ index: 0, qty: 2 }], preview: true });
  assert.equal(preview.body.preview.total, 34900); // the delivery charge stays free

  const res = await admin('POST', path, { items: [{ index: 0, qty: 2 }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.cancellations[0].by, 'Store Admin');
  assert.equal(res.body.cancellations[0].role, 'admin');
  assert.equal(alerts(), 0);
  assert.match(mailTo(call.email, 'Items cancelled').text, /We've cancelled these items/);
  const history = await t.db
    .collection('stockHistory')
    .findOne({ orderId: new ObjectId(order.id), reason: 'store_cancelled' });
  assert.equal(history.change, 2);
  const log = await t.db.collection('activity').findOne({ action: 'Cancelled items' });
  assert.equal(log.target.label, `Order #${order.number}`);
  assert.deepEqual(log.changes[0], { field: 'The Quiet Engineer (Paperback)', to: '2 cancelled' });
  // The customer's own view has the cancellation, without who did it.
  const mine = (await call('GET', `/orders/${order.id}`)).body;
  assert.equal(mine.cancellations[0].by, undefined);
  assert.equal(mine.total, 34900);
});
