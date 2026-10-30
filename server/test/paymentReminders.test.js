import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { sendPaymentReminders } from '../src/paymentReminders.js';
import { startTestServer } from './helpers.js';

let t;
let customer;
before(async () => {
  t = await startTestServer({ razorpay: true });
  customer = t.browser();
  const res = await customer('POST', '/auth/register', {
    name: 'Asha Rao',
    email: 'asha@example.com',
    password: 'password123',
  });
  assert.equal(res.status, 201);
});
after(() => t.stop());

const MINUTE = 60_000;
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
const reminders = () => t.mail.sent.filter((m) => m.subject.startsWith('Complete your payment'));

// A new order for one book, paid online (not yet) or by COD, made to look `minutes` old.
async function order(minutes, paymentMethod = 'razorpay') {
  const book = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const quote = await customer('GET', `/cart?items=${book._id}:1`);
  const res = await customer('POST', '/orders', {
    items: [{ productId: book._id.toString(), qty: 1 }],
    address,
    expectedTotal: quote.body.total,
    paymentMethod,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const _id = new ObjectId(res.body.id);
  const doc = await t.db.collection('orders').findOne({ _id });
  await t.db.collection('orders').updateOne(
    { _id },
    {
      $set: {
        createdAt: new Date(Date.now() - minutes * MINUTE),
        ...(doc.expiresAt && { expiresAt: new Date(Date.now() + (30 - minutes) * MINUTE) }),
      },
    },
  );
  return t.db.collection('orders').findOne({ _id });
}

test('one reminder 10 minutes after an unpaid online order, with a link back to pay', async () => {
  const unpaid = await order(5);
  assert.equal(await sendPaymentReminders(t.ctx), 0); // too soon
  await t.db
    .collection('orders')
    .updateOne(
      { _id: unpaid._id },
      { $set: { createdAt: new Date(Date.now() - 11 * MINUTE), expiresAt: new Date(Date.now() + 19 * MINUTE) } },
    );
  assert.equal(await sendPaymentReminders(t.ctx), 1);
  const [mail] = reminders();
  assert.equal(mail.to.email, 'asha@example.com');
  assert.equal(mail.subject, `Complete your payment for order #${unpaid.number}`);
  assert.match(mail.text, /We're holding your items until \d{1,2}:\d{2}\s?(am|pm) \(India time\)/i);
  assert.match(mail.text, /The Quiet Engineer \(Paperback\) × 1/);
  assert.match(mail.text, /To pay: ₹389/); // ₹349 and ₹40 delivery
  assert.ok(mail.text.includes(`Pay now: https://bazaar.test/orders/${unpaid._id}`));
  assert.equal(await sendPaymentReminders(t.ctx), 0); // once
});

test('no reminder when it was paid after all, too close to the end, or for COD', async () => {
  const before = reminders().length;

  // Paid at Razorpay, but the browser never said: the reminder sweep finds it and confirms the order instead.
  const paid = await order(12);
  t.fake.pay(paid.payment.razorpayOrderId);
  assert.equal(await sendPaymentReminders(t.ctx), 0);
  assert.equal((await t.db.collection('orders').findOne({ _id: paid._id })).status, 'placed');

  await order(27); // three minutes left: not worth it
  assert.equal(await sendPaymentReminders(t.ctx), 0);

  await order(15, 'cod'); // nothing to pay online
  assert.equal(await sendPaymentReminders(t.ctx), 0);
  assert.equal(reminders().length, before);
});

test('a failed email is tried again on the next sweep', async () => {
  await t.db.collection('orders').updateMany({ status: 'awaiting_payment' }, { $set: { status: 'cancelled' } });
  await order(12);
  t.mail.failNext();
  assert.equal(await sendPaymentReminders(t.ctx), 0);
  assert.equal(await sendPaymentReminders(t.ctx), 1);
});
