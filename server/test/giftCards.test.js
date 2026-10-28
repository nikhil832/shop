import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { remindGiftCards, sendScheduledGiftCards } from '../src/giftCards.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let buyer;
let friend;
before(async () => {
  t = await startTestServer({ razorpay: true });
  admin = await register('owner@example.com', 'Store Owner');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  buyer = await register('asha@example.com', 'Asha Rao');
  friend = await register('ravi@example.com', 'Ravi Kumar');
});
after(() => t.stop());
beforeEach(() => t.db.collection('rateLimits').deleteMany({}));

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  call.email = email;
  return call;
}

const DAY = 86_400_000;
const istDay = (offsetDays) => new Date(Date.now() + offsetDays * DAY + 330 * 60_000).toISOString().slice(0, 10);
const cards = () => t.db.collection('giftCards');
const mailTo = (email) => t.mail.sent.filter((m) => m.to.email === email);
const codeIn = (mail) => mail.text.match(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/)[0];
const balance = async (call) => (await call('GET', '/auth/me')).body.user.credit;

// Starts a card and pays for it through the stand-in Razorpay, as the browser would.
async function buyCard(body = {}) {
  const started = await buyer('POST', '/gift-cards', {
    amount: 100000,
    recipientName: 'Ravi Kumar',
    recipientEmail: 'ravi@example.com',
    message: 'Happy Diwali!',
    ...body,
  });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.checkout.amount, started.body.amount);
  const { response } = t.fake.pay(started.body.checkout.orderId);
  const paid = await buyer('POST', `/gift-cards/${started.body.id}/payment`, response);
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  return paid.body;
}

test('a paid card is emailed to the recipient (and a copy to the buyer); the code becomes store credit', async () => {
  t.mail.sent.length = 0;
  const card = await buyCard();
  assert.equal(card.status, 'sent');
  const [gift] = mailTo('ravi@example.com');
  assert.equal(gift.subject, 'Asha Rao sent you a ₹1,000 Bazaar gift card');
  assert.match(gift.text, /"Happy Diwali!"/);
  const [receipt] = mailTo('asha@example.com');
  const code = codeIn(gift);
  assert.equal(codeIn(receipt), code);
  // Only a hash of the code is kept.
  const doc = await cards().findOne({ last4: code.replaceAll('-', '').slice(-4) });
  assert.equal(doc.code, undefined);
  assert.ok(!JSON.stringify(doc).includes(code.replaceAll('-', '')));

  // Typed with spaces or in lower case, it still works; once.
  const redeemed = await friend('POST', '/gift-cards/redeem', { code: ` ${code.toLowerCase().replaceAll('-', ' ')} ` });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
  assert.deepEqual(redeemed.body, { amount: 100000, balance: 100000 });
  assert.equal(await balance(friend), 100000);
  const [entry] = (await friend('GET', '/account/credit')).body.items;
  assert.deepEqual([entry.reason, entry.note], ['gift_card', 'Gift card from Asha Rao']);
  const again = await buyer('POST', '/gift-cards/redeem', { code });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already been used/);
  const bought = (await buyer('GET', '/gift-cards')).body.bought;
  assert.equal(bought.find((c) => c.id === card.id).status, 'redeemed');
});

test('wrong codes are refused and count towards the hourly tries', async () => {
  for (let i = 0; i < 10; i++) {
    assert.equal((await friend('POST', '/gift-cards/redeem', { code: 'AAAA-BBBB-CCCC-DDDD' })).status, 404);
  }
  assert.equal((await friend('POST', '/gift-cards/redeem', { code: 'AAAA-BBBB-CCCC-DDDD' })).status, 429);
});

test('a card for a later day waits, then goes out on that day at 9 am India time', async () => {
  t.mail.sent.length = 0;
  const card = await buyCard({ sendOn: istDay(5) });
  assert.equal(card.status, 'scheduled');
  assert.equal(new Date(card.sendAt).toISOString(), `${istDay(5)}T03:30:00.000Z`);
  assert.equal(mailTo('ravi@example.com').length, 0);
  const copy = codeIn(mailTo('asha@example.com')[0]);

  assert.equal(await sendScheduledGiftCards(t.ctx, new Date(Date.now() + 4 * DAY)), 0);
  assert.equal(await sendScheduledGiftCards(t.ctx, new Date(Date.now() + 6 * DAY)), 1);
  assert.equal(codeIn(mailTo('ravi@example.com')[0]), copy);
  const doc = await cards().findOne({ status: 'sent', last4: copy.replaceAll('-', '').slice(-4) });
  assert.equal(doc.code, undefined); // gone once sent
  // A year from the day it was sent.
  assert.equal(doc.expiresAt.getTime(), doc.sendAt.getTime() + 365 * DAY);
});

test('a failed send is tried again next minute', async () => {
  const card = await buyCard({ sendOn: istDay(2) });
  t.mail.failNext();
  assert.equal(await sendScheduledGiftCards(t.ctx, new Date(Date.now() + 3 * DAY)), 0);
  assert.equal((await cards().findOne({ status: 'scheduled' }))?._id.toString(), card.id);
  assert.equal(await sendScheduledGiftCards(t.ctx, new Date(Date.now() + 3 * DAY)), 1);
});

test('an unredeemed card is reminded about once, a month before, and refused once run out', async () => {
  t.mail.sent.length = 0;
  const card = await buyCard();
  const code = codeIn(mailTo('ravi@example.com')[0]);
  const _id = (await cards().findOne({ status: 'sent', last4: code.replaceAll('-', '').slice(-4) }))._id;
  await cards().updateOne({ _id }, { $set: { expiresAt: new Date(Date.now() + 10 * DAY) } });
  await remindGiftCards(t.ctx);
  await remindGiftCards(t.ctx);
  const reminders = mailTo('ravi@example.com').filter((m) => m.subject.startsWith('Your Bazaar gift card runs out'));
  assert.equal(reminders.length, 1);

  await cards().updateOne({ _id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const late = await friend('POST', '/gift-cards/redeem', { code });
  assert.equal(late.status, 409);
  assert.match(late.body.error, /run out/);
  assert.equal((await buyer('GET', '/gift-cards')).body.bought.find((c) => c.id === card.id).status, 'expired');
});

test('the webhook confirms a card the browser never reported', async () => {
  const started = await buyer('POST', '/gift-cards', {
    amount: 50000,
    recipientName: 'Meera',
    recipientEmail: 'meera@example.com',
  });
  const { payment } = t.fake.pay(started.body.checkout.orderId);
  const { body, signature } = t.fake.webhook('payment.captured', payment);
  for (let i = 0; i < 2; i++) assert.equal((await t.webhook(body, signature)).status, 200);
  assert.equal(mailTo('meera@example.com').length, 1); // once
  assert.equal((await cards().findOne({ 'recipient.email': 'meera@example.com' })).status, 'sent');
});

test('admins cancel an unredeemed card: the buyer is refunded and emailed, and the code stops working', async () => {
  t.mail.sent.length = 0;
  const card = await buyCard({ amount: 200000 });
  const code = codeIn(mailTo('ravi@example.com')[0]);
  const list = (await admin('GET', '/admin/gift-cards?status=sent')).body;
  assert.ok(list.items.some((c) => c.id === card.id && c.buyer.email === 'asha@example.com'));

  const res = await admin('POST', `/admin/gift-cards/${card.id}/cancel`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual([res.body.status, res.body.payment.status], ['cancelled', 'refunded']);
  assert.equal(t.fake.state.refunds.at(-1).amount, 200000);
  assert.ok(mailTo('asha@example.com').some((m) => m.subject === 'Your ₹2,000 gift card was cancelled'));
  assert.match((await friend('POST', '/gift-cards/redeem', { code })).body.error, /cancelled/);
  assert.equal((await admin('POST', `/admin/gift-cards/${card.id}/cancel`)).status, 409);
  assert.ok(await t.db.collection('activity').findOne({ area: 'giftCards', action: 'Cancelled gift card' }));
});

test('what can be bought is checked; buying needs an account; the admin list needs an admin', async () => {
  const base = { amount: 100000, recipientName: 'Ravi', recipientEmail: 'ravi@example.com' };
  for (const [body, error] of [
    [{ ...base, amount: 123400 }, 'Choose an amount'],
    [{ ...base, recipientEmail: 'nope' }, 'Enter their email'],
    [{ ...base, sendOn: istDay(-1) }, 'Choose today or a later day'],
    [{ ...base, sendOn: istDay(100) }, 'At most 90 days ahead'],
    [{ ...base, message: 'x'.repeat(301) }, 'At most 300 characters'],
  ]) {
    const res = await buyer('POST', '/gift-cards', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.error.includes(error), `${res.body.error} / ${error}`);
  }
  assert.equal((await t.call('POST', '/gift-cards', base)).status, 401);
  assert.equal((await t.call('POST', '/gift-cards/redeem', { code: 'x' })).status, 401);
  assert.equal((await buyer('GET', '/admin/gift-cards')).status, 403);
  const page = (await t.call('GET', '/gift-cards')).body;
  assert.deepEqual([page.available, page.amounts, page.bought], [true, [50000, 100000, 200000, 500000], []]);
});
