import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { sendPriceDropEmails } from '../src/routes/wishlist.js';

let t;
let asha;
let ravi;
before(async () => {
  t = await startTestServer();
  asha = await register('asha@example.com', 'Asha Rao');
  ravi = await register('ravi@example.com', 'Ravi Kumar');
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}

const products = () => t.db.collection('products');
const product = (slug) => products().findOne({ slug });
const setPrice = (slug, price, extra = {}) => products().updateOne({ slug }, { $set: { price, ...extra } });
const save = async (who, slug) => who('PUT', `/wishlist/${(await product(slug))._id}`);
const dropsTo = (email) => t.mail.sent.filter((m) => m.to.email === email && /^Price drop/.test(m.subject));
const BOOK = 'the-quiet-engineer-paperback'; // ₹349
const PHONE = 'orbit-a14-4gb-ram-64gb'; // ₹8,999

test('saving remembers the price; a drop of 5% or more is emailed once', async () => {
  await save(asha, BOOK);
  const saved = await t.db.collection('wishlist').findOne({ productId: (await product(BOOK))._id });
  assert.equal(saved.seenPrice, 34900);
  assert.equal(await sendPriceDropEmails(t.ctx), 0);

  await setPrice(BOOK, 33500); // 4% less: not worth an email
  assert.equal(await sendPriceDropEmails(t.ctx), 0);
  await setPrice(BOOK, 29900); // 14% less
  assert.equal(await sendPriceDropEmails(t.ctx), 1);
  const [mail] = dropsTo('asha@example.com');
  assert.equal(mail.subject, 'Price drop: The Quiet Engineer (Paperback) is now ₹299');
  assert.ok(mail.text.includes('The Quiet Engineer (Paperback): ₹349 → ₹299 (14% less)'));
  assert.ok(mail.text.includes('https://bazaar.test/p/the-quiet-engineer-paperback'));
  assert.ok(mail.text.includes('https://bazaar.test/account'));
  assert.equal(await sendPriceDropEmails(t.ctx), 0); // told already
});

test('a price that rises and falls back is not news; a new low is', async () => {
  await setPrice(BOOK, 34900);
  await sendPriceDropEmails(t.ctx);
  await setPrice(BOOK, 29900);
  assert.equal(await sendPriceDropEmails(t.ctx), 0);
  await setPrice(BOOK, 27900);
  assert.equal(await sendPriceDropEmails(t.ctx), 1);
  assert.ok(dropsTo('asha@example.com').at(-1).text.includes('₹299 → ₹279'));
});

test('several drops for one customer come in one email; sold-out and hidden products wait', async () => {
  await save(ravi, BOOK);
  await save(ravi, PHONE);
  await save(ravi, 'bolt-bass-neckband');
  await setPrice(BOOK, 24900);
  await setPrice(PHONE, 799900);
  await setPrice('bolt-bass-neckband', 50000, { stock: 0 }); // sold out
  assert.equal(await sendPriceDropEmails(t.ctx), 2); // Ravi (two items) and Asha (the book)
  const mail = dropsTo('ravi@example.com').at(-1);
  assert.equal(mail.subject, 'Price drops on 2 items on your wishlist');
  assert.ok(!mail.text.includes('Bolt Bass'));

  await products().updateOne({ slug: 'bolt-bass-neckband' }, { $set: { stock: 5, active: false } });
  assert.equal(await sendPriceDropEmails(t.ctx), 0); // hidden
  await products().updateOne({ slug: 'bolt-bass-neckband' }, { $set: { active: true } });
  assert.equal(await sendPriceDropEmails(t.ctx), 1);
  assert.match(dropsTo('ravi@example.com').at(-1).subject, /Bolt Bass/);
});

test('customers can switch these emails off on their account, and back on', async () => {
  const off = await asha('PUT', '/account/email-preferences', { priceDropEmails: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.user.priceDropEmails, false);
  assert.equal((await asha('GET', '/auth/me')).body.user.priceDropEmails, false);
  assert.equal((await asha('PUT', '/account/email-preferences', { priceDropEmails: 'no' })).status, 400);
  assert.equal((await t.call('PUT', '/account/email-preferences', { priceDropEmails: true })).status, 401);

  const before = dropsTo('asha@example.com').length;
  await setPrice(BOOK, 19900);
  assert.equal(await sendPriceDropEmails(t.ctx), 1); // Ravi only
  assert.equal(dropsTo('asha@example.com').length, before);
  await asha('PUT', '/account/email-preferences', { priceDropEmails: true });
  assert.equal(await sendPriceDropEmails(t.ctx), 1);
  assert.equal(dropsTo('asha@example.com').length, before + 1);
});

test('a failed email is tried again; two sweeps at once send one', async () => {
  await setPrice(PHONE, 699900);
  t.mail.failNext();
  assert.equal(await sendPriceDropEmails(t.ctx), 0);
  assert.equal(await sendPriceDropEmails(t.ctx), 1);
  assert.ok(dropsTo('ravi@example.com').at(-1).text.includes('₹7,999 → ₹6,999'));

  await setPrice(PHONE, 599900);
  const results = await Promise.all([sendPriceDropEmails(t.ctx), sendPriceDropEmails(t.ctx)]);
  assert.equal(results[0] + results[1], 1);
});

test('items saved before this existed get today’s price first, without an email', async () => {
  const kurta = await product('urbane-women-kurta-set');
  const user = await t.db.collection('users').findOne({ email: 'asha@example.com' });
  await t.db.collection('wishlist').insertOne({ userId: user._id, productId: kurta._id, addedAt: new Date() });
  await products().updateOne({ _id: kurta._id }, { $set: { price: 100000 } });
  const sentBefore = t.mail.sent.length;
  assert.equal(await sendPriceDropEmails(t.ctx), 0);
  assert.equal(t.mail.sent.length, sentBefore);
  assert.equal((await t.db.collection('wishlist').findOne({ productId: kurta._id })).seenPrice, 100000);
  // From then on it counts: and a product whose sizes differ in price says "from".
  await products().updateOne({ _id: kurta._id }, { $set: { price: 80000 } });
  assert.equal(await sendPriceDropEmails(t.ctx), 1);
  assert.ok(dropsTo('asha@example.com').at(-1).text.includes('₹1,000 → from ₹800 (20% less)'));
});
