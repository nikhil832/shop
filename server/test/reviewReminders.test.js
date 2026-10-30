import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { startTestServer } from './helpers.js';
import { sendReviewReminders } from '../src/reviewReminders.js';

let t;
let admin;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'Store Admin');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
});
after(() => t.stop());

let n = 0;
async function register(email = `buyer${++n}@example.com`, name = 'Asha Rao') {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name, email, password: 'password123' });
  assert.equal(res.status, 201);
  return call;
}

const BOOK = 'the-quiet-engineer-paperback';
const PHONE = 'orbit-a14-4gb-ram-64gb';
const DAY = 24 * 60 * 60 * 1000;
const product = (slug) => t.db.collection('products').findOne({ slug });
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
const reminders = (email) =>
  t.mail.sent.filter((m) => m.to.email === email && m.text.includes('A short review helps other customers'));

// Places a COD order for one of each slug, has the admin deliver it, and makes the delivery `days` old.
async function delivered(call, slugs, days) {
  const products = await Promise.all(slugs.map(product));
  const quote = await call('GET', `/cart?items=${products.map((p) => `${p._id}:1`).join(',')}`);
  const order = await call('POST', '/orders', {
    items: products.map((p) => ({ productId: p._id.toString(), qty: 1 })),
    address,
    expectedTotal: quote.body.total,
  });
  assert.equal(order.status, 201);
  for (const status of ['shipped', 'delivered']) {
    assert.equal((await admin('POST', `/admin/orders/${order.body.id}/status`, { status })).status, 200);
  }
  await age(order.body.id, days);
  return order.body;
}
const age = (id, days) =>
  t.db
    .collection('orders')
    .updateOne({ _id: new ObjectId(id) }, { $set: { deliveredAt: new Date(Date.now() - days * DAY) } });

test('one email per delivered order, three days after delivery, for products not yet reviewed', async () => {
  const call = await register('asha@example.com');
  const order = await delivered(call, [BOOK, PHONE], 2);
  assert.equal(await sendReviewReminders(t.ctx), 0); // too soon
  await age(order.id, 3.1);
  assert.equal(await call('PUT', `/products/${PHONE}/review`, { rating: 4 }).then((r) => r.status), 200);
  assert.equal(await sendReviewReminders(t.ctx), 1);
  const [mail] = reminders('asha@example.com');
  assert.equal(mail.subject, 'How is your The Quiet Engineer (Paperback)?');
  assert.ok(mail.text.includes(`Your order #${order.number} arrived`));
  assert.ok(mail.text.includes(`https://bazaar.test/p/${BOOK}#reviews`));
  assert.ok(!mail.text.includes(PHONE)); // already reviewed
  assert.ok(mail.html.includes('Write a review'));
  assert.equal(await sendReviewReminders(t.ctx), 0); // once per order
  const stored = await t.db.collection('orders').findOne({ _id: new ObjectId(order.id) });
  assert.equal(stored.reviewReminder.sent, true);
  // Not part of the order as customers see it.
  assert.equal((await call('GET', `/orders/${order.id}`)).body.reviewReminder, undefined);
});

test('two products get one email naming the order', async () => {
  const call = await register('ravi@example.com', 'Ravi Kumar');
  const order = await delivered(call, [BOOK, PHONE], 4);
  assert.equal(await sendReviewReminders(t.ctx), 1);
  const [mail] = reminders('ravi@example.com');
  assert.equal(mail.subject, `How are the things from order #${order.number}?`);
  assert.ok(mail.text.startsWith('Hi Ravi,'));
  assert.ok(mail.text.includes(`/p/${BOOK}#reviews`) && mail.text.includes(`/p/${PHONE}#reviews`));
});

test('nothing for old deliveries, returned or hidden products, closed accounts, or when switched off', async () => {
  const call = await register('meera@example.com');

  await delivered(call, [BOOK], 15); // delivered before the window: let go
  assert.equal(await sendReviewReminders(t.ctx), 0);

  // Returned in full.
  const returned = await delivered(call, [BOOK], 1);
  await t.db.collection('returns').insertOne({
    orderId: new ObjectId(returned.id),
    status: 'requested',
    items: [{ index: 0, qty: 1 }],
  });
  await age(returned.id, 4);
  assert.equal(await sendReviewReminders(t.ctx), 0);

  // Hidden since.
  const hidden = await delivered(call, [PHONE], 1);
  await t.db.collection('products').updateOne({ slug: PHONE }, { $set: { active: false } });
  await age(hidden.id, 4);
  assert.equal(await sendReviewReminders(t.ctx), 0);
  await t.db.collection('products').updateOne({ slug: PHONE }, { $set: { active: true } });
  assert.equal(await sendReviewReminders(t.ctx), 0); // looked at once, not again

  // Switched off.
  const off = await call('PUT', '/account/email-preferences', { reviewReminderEmails: false });
  assert.equal(off.body.user.reviewReminderEmails, false);
  assert.equal(off.body.user.cartReminderEmails, true); // the other choices are left as they were
  await delivered(call, [BOOK], 4);
  assert.equal(await sendReviewReminders(t.ctx), 0);
  assert.equal(reminders('meera@example.com').length, 0);
  assert.equal((await call('PUT', '/account/email-preferences', { reviewReminderEmails: 'yes' })).status, 400);

  // The account is gone.
  const gone = await register();
  const order = await delivered(gone, [BOOK], 4);
  await t.db.collection('users').deleteOne({ email: `buyer${n}@example.com` });
  assert.equal(await sendReviewReminders(t.ctx), 0);
  assert.ok((await t.db.collection('orders').findOne({ _id: new ObjectId(order.id) })).reviewReminder);
});

test('a failed email is tried again on the next sweep', async () => {
  const call = await register('kiran@example.com');
  await delivered(call, [BOOK], 4);
  t.mail.failNext();
  assert.equal(await sendReviewReminders(t.ctx), 0);
  assert.equal(await sendReviewReminders(t.ctx), 1);
  assert.equal(reminders('kiran@example.com').length, 1);
});
