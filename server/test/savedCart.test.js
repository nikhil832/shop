import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { sendCartReminders } from '../src/routes/savedCart.js';

let t;
let phone; // one account, two devices
let laptop;
before(async () => {
  t = await startTestServer();
  phone = t.browser();
  assert.equal(
    (await phone('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' }))
      .status,
    201,
  );
  laptop = t.browser();
  await laptop('POST', '/auth/login', { email: 'asha@example.com', password: 'password123' });
});
after(() => t.stop());

const product = (slug) => t.db.collection('products').findOne({ slug });
const id = async (slug) => (await product(slug))._id.toString();
const HOUR = 3_600_000;
const reminders = () => t.mail.sent.filter((m) => m.subject === 'You left something in your cart');
// Makes the saved cart look `hours` old.
const age = async (hours, email = 'asha@example.com') => {
  const user = await t.db.collection('users').findOne({ email });
  await t.db
    .collection('carts')
    .updateOne({ _id: user._id }, { $set: { updatedAt: new Date(Date.now() - hours * HOUR) } });
};

test('the cart is saved in the account and read from another device', async () => {
  assert.equal((await t.call('GET', '/cart/saved')).status, 401);
  assert.deepEqual((await phone('GET', '/cart/saved')).body, { items: [], updatedAt: null });

  const shoes = await product('stride-running-shoes');
  const items = [
    { productId: await id('the-quiet-engineer-paperback'), qty: 2 },
    { productId: shoes._id.toString(), variantId: shoes.variants[1]._id.toString(), qty: 1 },
  ];
  const put = await phone('PUT', '/cart/saved', { items });
  assert.equal(put.status, 200);
  assert.deepEqual((await laptop('GET', '/cart/saved')).body.items, items);

  assert.deepEqual((await laptop('PUT', '/cart/saved', { items: [] })).body.items, []);
  assert.deepEqual((await phone('GET', '/cart/saved')).body.items, []);
});

test('saved carts are checked like carts', async () => {
  const book = await id('the-quiet-engineer-paperback');
  const bad = async (items) => (await phone('PUT', '/cart/saved', { items })).status;
  assert.equal(await bad([{ productId: book, qty: 11 }]), 400);
  assert.equal(
    await bad([
      { productId: book, qty: 1 },
      { productId: book, qty: 2 },
    ]),
    400,
  );
  assert.equal(await bad([{ productId: 'nope', qty: 1 }]), 400);
  const many = Array.from({ length: 21 }, (_, i) => ({ productId: i.toString(16).padStart(24, '0'), qty: 1 }));
  assert.equal(await bad(many), 400);
  assert.equal((await phone('PUT', '/cart/saved', {})).status, 400);
});

test('a cart left for a day gets one reminder, with today’s prices', async () => {
  const shoes = await product('stride-running-shoes');
  const size = shoes.variants[1];
  await phone('PUT', '/cart/saved', {
    items: [
      { productId: await id('the-quiet-engineer-paperback'), qty: 2 },
      { productId: shoes._id.toString(), variantId: size._id.toString(), qty: 1 },
    ],
  });
  assert.equal(await sendCartReminders(t.ctx), 0); // just now
  await age(23);
  assert.equal(await sendCartReminders(t.ctx), 0);
  await age(25);
  await t.db.collection('products').updateOne({ slug: 'the-quiet-engineer-paperback' }, { $set: { price: 29900 } });
  assert.equal(await sendCartReminders(t.ctx), 1);
  const [mail] = reminders();
  assert.equal(mail.to.email, 'asha@example.com');
  assert.ok(mail.text.includes('The Quiet Engineer (Paperback): 2 × ₹299'));
  assert.ok(mail.text.includes(`Stride Running Shoes (Size: ${size.label}): ₹`));
  assert.ok(mail.text.includes('https://bazaar.test/cart'));
  assert.equal(await sendCartReminders(t.ctx), 0); // once per cart

  // Changing the cart makes it a new cart, reminded a day later.
  await laptop('PUT', '/cart/saved', { items: [{ productId: await id('orbit-a14-4gb-ram-64gb'), qty: 1 }] });
  assert.equal(await sendCartReminders(t.ctx), 0);
  await age(30);
  assert.equal(await sendCartReminders(t.ctx), 1);
  assert.equal(reminders().length, 2);
});

test('no reminder after an order, for old carts, unbuyable carts, or when switched off', async () => {
  const phoneId = await id('orbit-a14-4gb-ram-64gb');
  const fresh = async (items = [{ productId: phoneId, qty: 1 }]) => phone('PUT', '/cart/saved', { items });
  const before = reminders().length;

  await fresh();
  await age(8 * 24); // a week old: let go
  assert.equal(await sendCartReminders(t.ctx), 0);

  await fresh();
  await age(30);
  const user = await t.db.collection('users').findOne({ email: 'asha@example.com' });
  await t.db.collection('orders').insertOne({ userId: user._id, createdAt: new Date(), status: 'placed', items: [] });
  assert.equal(await sendCartReminders(t.ctx), 0); // ordered since
  await t.db.collection('orders').deleteMany({ userId: user._id });

  await fresh();
  await age(30);
  await t.db.collection('products').updateOne({ slug: 'orbit-a14-4gb-ram-64gb' }, { $set: { active: false } });
  assert.equal(await sendCartReminders(t.ctx), 0); // nothing in it can be bought
  await t.db.collection('products').updateOne({ slug: 'orbit-a14-4gb-ram-64gb' }, { $set: { active: true } });

  const off = await phone('PUT', '/account/email-preferences', { cartReminderEmails: false });
  assert.equal(off.body.user.cartReminderEmails, false);
  assert.equal(off.body.user.priceDropEmails, true); // the other choice is left as it was
  await fresh();
  await age(30);
  assert.equal(await sendCartReminders(t.ctx), 0);
  assert.equal(reminders().length, before);
  assert.equal((await phone('PUT', '/account/email-preferences', {})).status, 400);
  await phone('PUT', '/account/email-preferences', { cartReminderEmails: true });
});

test('a failed reminder is tried again; two sweeps at once send one', async () => {
  await phone('PUT', '/cart/saved', { items: [{ productId: await id('orbit-a14-4gb-ram-64gb'), qty: 1 }] });
  await age(30);
  t.mail.failNext();
  assert.equal(await sendCartReminders(t.ctx), 0);
  const results = await Promise.all([sendCartReminders(t.ctx), sendCartReminders(t.ctx)]);
  assert.equal(results[0] + results[1], 1);
});
