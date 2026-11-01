import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { sendPriceDropEmails, sendPriceTargetEmails } from '../src/routes/wishlist.js';

// Price targets on wishlist items (stage 142).
let t;
let asha;
let ravi;
before(async () => {
  t = await startTestServer();
  asha = await register('asha@example.com', 'Asha Rao');
  ravi = await register('ravi@example.com', 'Ravi Kumar');
});
after(() => t.stop());
beforeEach(() => {
  t.mail.sent.length = 0;
});

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}

const products = () => t.db.collection('products');
const product = (slug) => products().findOne({ slug });
const setPrice = (slug, price) => products().updateOne({ slug }, { $set: { price } });
const BOOK = 'the-quiet-engineer-paperback'; // ₹349
const PHONE = 'orbit-a14-4gb-ram-64gb'; // ₹8,999
const target = async (who, slug, targetPrice) =>
  who('PUT', `/wishlist/${(await product(slug))._id}/target`, { targetPrice });
const listed = async (who, slug) => (await who('GET', '/wishlist')).body.find((p) => p.slug === slug);

test('a target is set on a saved item, below its price, in whole rupees', async () => {
  assert.equal((await target(asha, BOOK, 29900)).status, 404); // not saved yet
  await asha('PUT', `/wishlist/${(await product(BOOK))._id}`);
  for (const [bad, pattern] of [
    [34900, /It's ₹349 now/],
    [40000, /choose a lower price/],
    [29950, /whole rupees/],
    [0, /At least ₹1/],
  ]) {
    const res = await target(asha, BOOK, bad);
    assert.equal(res.status, 400, String(bad));
    assert.match(res.body.error, pattern);
  }
  const res = await target(asha, BOOK, 29900);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual((await listed(asha, BOOK)).target, { price: 29900, reachedAt: null });
  assert.equal((await asha('GET', '/account/data')).body.wishlist[0].priceAlert, 29900);
  assert.equal(
    (await t.call('PUT', `/wishlist/${(await product(BOOK))._id}/target`, { targetPrice: 100 })).status,
    401,
  );
});

test('reaching the target sends one email, instead of the 5% one, even with price drops off', async () => {
  await t.db.collection('users').updateOne({ email: 'asha@example.com' }, { $set: { priceDropEmails: false } });
  await setPrice(BOOK, 31900); // 9% less, above the target: nothing (waiting for the target)
  assert.equal(await sendPriceDropEmails(t.ctx), 0);
  assert.equal(await sendPriceTargetEmails(t.ctx), 0);

  await setPrice(BOOK, 29900);
  assert.equal(await sendPriceDropEmails(t.ctx), 0);
  assert.equal(await sendPriceTargetEmails(t.ctx), 1);
  assert.equal(await sendPriceTargetEmails(t.ctx), 0); // once
  const [mail] = t.mail.sent;
  assert.equal(mail.to.email, 'asha@example.com');
  assert.equal(mail.subject, 'The Quiet Engineer (Paperback) is now ₹299, your price');
  assert.match(mail.text, /now ₹299 \(you asked for ₹299 or less\)/);
  const item = await listed(asha, BOOK);
  assert.equal(item.target.price, 29900);
  assert.ok(item.target.reachedAt);
  // The 5% emails start again from the price told.
  const saved = await t.db.collection('wishlist').findOne({ productId: (await product(BOOK))._id });
  assert.equal(saved.seenPrice, 29900);

  // A new target starts afresh; removing it takes it away.
  await target(asha, BOOK, 25000);
  assert.equal((await listed(asha, BOOK)).target.reachedAt, null);
  assert.equal((await target(asha, BOOK, null)).status, 200);
  assert.equal((await listed(asha, BOOK)).target, null);
  await setPrice(BOOK, 34900);
});

test('sold out or hidden waits; a failed send is tried again; several items make one email', async () => {
  await ravi('PUT', `/wishlist/${(await product(BOOK))._id}`);
  await ravi('PUT', `/wishlist/${(await product(PHONE))._id}`);
  await target(ravi, BOOK, 30000);
  await target(ravi, PHONE, 8000);
  await products().updateOne({ slug: BOOK }, { $set: { price: 29900, stock: 0 } });
  await products().updateOne({ slug: PHONE }, { $set: { price: 7999, active: false } });
  assert.equal(await sendPriceTargetEmails(t.ctx), 0);

  await products().updateOne({ slug: BOOK }, { $set: { stock: 10 } });
  await products().updateOne({ slug: PHONE }, { $set: { active: true } });
  t.mail.failNext();
  assert.equal(await sendPriceTargetEmails(t.ctx), 0);
  assert.equal((await listed(ravi, BOOK)).target.reachedAt, null);
  assert.equal(await sendPriceTargetEmails(t.ctx), 1);
  const [mail] = t.mail.sent;
  assert.equal(mail.subject, '2 items on your wishlist reached your price');
});
