import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SET_PASSWORD_DAYS } from '../src/passwordLinks.js';
import { startTestServer } from './helpers.js';

let t;
before(async () => {
  t = await startTestServer();
});
after(() => t.stop());
beforeEach(() => t.db.collection('rateLimits').deleteMany({}));

const address = {
  name: 'Meera Iyer',
  phone: '9876543210',
  line1: '4 Lake View',
  city: 'Chennai',
  state: 'Tamil Nadu',
  pincode: '600001',
};
async function order(call) {
  const p = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const quote = await call('GET', `/cart?items=${p._id}:1`);
  const res = await call('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty: 1 }],
    address,
    expectedTotal: quote.body.total,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
const linkIn = (mail) => mail.text.match(/\/reset-password#token=([\w-]+)/)?.[1] ?? null;

test('a new customer checks out with a name and email; the confirmation brings a link to set a password', async () => {
  const call = t.browser();
  const res = await call('POST', '/auth/quick-account', { name: 'Meera Iyer', email: 'Meera@Example.com' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.user.email, 'meera@example.com');
  assert.equal(res.body.user.hasPassword, false);
  assert.equal((await call('GET', '/auth/me')).body.user.name, 'Meera Iyer'); // logged in at once

  await order(call);
  const mail = t.mail.sent.findLast((m) => m.to.email === 'meera@example.com');
  assert.match(mail.subject, /confirmed$/);
  assert.match(mail.text, /We've made you a Bazaar account/);
  const token = linkIn(mail);
  assert.ok(token);
  const link = await t.db.collection('passwordResets').findOne({ purpose: 'set' });
  const days = (link.expiresAt - link.createdAt) / 86_400_000;
  assert.equal(days, SET_PASSWORD_DAYS);

  // No password works until one is set.
  const guess = t.browser();
  assert.equal((await guess('POST', '/auth/login', { email: 'meera@example.com', password: 'anything' })).status, 401);
  // Setting it logs out every other session (as a reset does) and logs this browser in.
  const setter = t.browser();
  const set = await setter('POST', '/auth/reset-password', { token, password: 'a-new-password-1' });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.user.hasPassword, true);
  const login = await t.browser()('POST', '/auth/login', { email: 'meera@example.com', password: 'a-new-password-1' });
  assert.equal(login.status, 200);

  // With a password, order emails don't offer one any more.
  await order(setter);
  assert.equal(linkIn(t.mail.sent.findLast((m) => m.to.email === 'meera@example.com')), null);
});

test('an email that has an account must log in; logged-in visitors and bad input are refused', async () => {
  const owner = t.browser();
  await owner('POST', '/auth/register', { name: 'Ravi', email: 'ravi@example.com', password: 'password123' });
  const taken = await t.browser()('POST', '/auth/quick-account', { name: 'Someone', email: 'ravi@example.com' });
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /log in to check out/);
  assert.equal((await owner('POST', '/auth/quick-account', { name: 'Ravi', email: 'other@example.com' })).status, 400);
  assert.equal((await t.browser()('POST', '/auth/quick-account', { name: '', email: 'x@example.com' })).status, 400);
  assert.equal((await t.browser()('POST', '/auth/quick-account', { name: 'X', email: 'not-an-email' })).status, 400);
});

test('at most 5 new accounts an hour from one network', async () => {
  for (let i = 0; i < 5; i++) {
    const res = await t.browser()('POST', '/auth/quick-account', { name: 'Bot', email: `bot${i}@example.com` });
    assert.equal(res.status, 201);
  }
  assert.equal(
    (await t.browser()('POST', '/auth/quick-account', { name: 'Bot', email: 'bot9@example.com' })).status,
    429,
  );
});

test('without a password, closing the account needs one first; forgot password sends a link', async () => {
  const call = t.browser();
  await call('POST', '/auth/quick-account', { name: 'Kiran', email: 'kiran@example.com' });
  const close = await call('POST', '/account/close', { password: 'whatever1', confirm: true });
  assert.equal(close.status, 400);
  assert.equal(close.body.error, 'Your password is wrong');
  // Forgot password works for them too (it's how they get a fresh link).
  t.mail.sent.length = 0;
  assert.equal((await t.browser()('POST', '/auth/forgot-password', { email: 'kiran@example.com' })).status, 204);
  for (let i = 0; i < 50 && !t.mail.sent.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(linkIn(t.mail.sent[0]));
});
