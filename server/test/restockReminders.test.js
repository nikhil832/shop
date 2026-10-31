import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { startTestServer } from './helpers.js';
import { sendRestockReminders } from '../src/restockReminders.js';

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
  call.email = email;
  return call;
}

const BOOK = 'the-quiet-engineer-paperback';
const COFFEE = 'learning-to-code-with-javascript'; // stands in for something that runs out
const DAY = 86_400_000;
const product = (slug) => t.db.collection('products').findOne({ slug });
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
const reminders = (email) => t.mail.sent.filter((m) => m.to.email === email && /running low/.test(m.text));
const setDays = async (slug, restockDays) => {
  const p = await product(slug);
  const res = await admin('PATCH', `/admin/products/${p._id}`, { restockDays });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

// Places a COD order for one of each slug, has the admin deliver it, and makes the delivery `days` old.
async function delivered(call, slugs, days) {
  const products = await Promise.all(slugs.map(product));
  const quote = await call('GET', `/cart?items=${products.map((p) => `${p._id}:1`).join(',')}`);
  const order = await call('POST', '/orders', {
    items: products.map((p) => ({ productId: p._id.toString(), qty: 1 })),
    address,
    expectedTotal: quote.body.total,
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  for (const status of ['shipped', 'delivered']) {
    assert.equal((await admin('POST', `/admin/orders/${order.body.id}/status`, { status })).status, 200);
  }
  const at = new Date(Date.now() - days * DAY);
  await t.db
    .collection('orders')
    .updateOne({ _id: new ObjectId(order.body.id) }, { $set: { deliveredAt: at, createdAt: new Date(at - DAY) } });
  return order.body;
}

test('admins set the days on a product; they are checked, shown and logged', async () => {
  const saved = await setDays(COFFEE, 30);
  assert.equal(saved.restockDays, 30);
  const p = await product(COFFEE);
  assert.equal((await admin('PATCH', `/admin/products/${p._id}`, { restockDays: 3 })).status, 400);
  assert.equal((await admin('PATCH', `/admin/products/${p._id}`, { restockDays: 400 })).status, 400);
  const log = await t.db.collection('activity').findOne({ 'changes.field': 'Restock reminder' });
  assert.deepEqual(
    log.changes.find((c) => c.field === 'Restock reminder'),
    { field: 'Restock reminder', from: 'none', to: 'after 30 days' },
  );
});

test('one email when it may be running low, once, for products with days set', async () => {
  await setDays(COFFEE, 30);
  const asha = await register();
  await delivered(asha, [COFFEE, BOOK], 25); // not yet
  assert.equal(await sendRestockReminders(t.ctx), 0);

  const ravi = await register();
  await delivered(ravi, [COFFEE, BOOK], 31);
  assert.equal(await sendRestockReminders(t.ctx), 1);
  const [mail] = reminders(ravi.email);
  const coffee = await product(COFFEE);
  assert.equal(mail.subject, `Running low on ${coffee.title}?`);
  assert.match(mail.text, new RegExp(`/p/${COFFEE}`));
  assert.doesNotMatch(mail.text, new RegExp(BOOK)); // the book has no days set
  // Never twice.
  assert.equal(await sendRestockReminders(t.ctx), 0);
  assert.equal(reminders(ravi.email).length, 1);
});

test('not for old deliveries, repeat buys, returns, sold-out products or customers who said no', async () => {
  await setDays(COFFEE, 30);
  const old = await register();
  await delivered(old, [COFFEE], 30 + 15); // past the 14 late days
  const again = await register();
  await delivered(again, [COFFEE], 32);
  await delivered(again, [COFFEE], 1); // bought again since
  const no = await register();
  await delivered(no, [COFFEE], 33);
  assert.equal((await no('PUT', '/account/email-preferences', { restockReminderEmails: false })).status, 200);
  assert.equal((await no('GET', '/auth/me')).body.user.restockReminderEmails, false);
  const back = await register();
  const sentBack = await delivered(back, [COFFEE], 34);
  await t.db.collection('returns').insertOne({
    orderId: new ObjectId(sentBack.id),
    items: [{ index: 0, productId: (await product(COFFEE))._id, qty: 1 }],
    status: 'requested',
    createdAt: new Date(),
  });

  assert.equal(await sendRestockReminders(t.ctx), 0);
  for (const call of [old, again, no, back]) assert.equal(reminders(call.email).length, 0);

  // Sold out: no email, and it isn't asked about later either.
  const late = await register();
  await delivered(late, [COFFEE], 31);
  await t.db.collection('products').updateOne({ slug: COFFEE }, { $set: { stock: 0 } });
  assert.equal(await sendRestockReminders(t.ctx), 0);
  await t.db.collection('products').updateOne({ slug: COFFEE }, { $set: { stock: 50 } });
  assert.equal(await sendRestockReminders(t.ctx), 0);
});

test('a failed email is tried again on the next sweep', async () => {
  await setDays(COFFEE, 30);
  const meera = await register();
  await delivered(meera, [COFFEE], 31);
  t.mail.failNext();
  assert.equal(await sendRestockReminders(t.ctx), 0);
  assert.equal(await sendRestockReminders(t.ctx), 1);
  assert.equal(reminders(meera.email).length, 1);
});
