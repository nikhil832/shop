import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
before(async () => (t = await startTestServer()));
after(() => t.stop());

let n = 0;
async function register(email = `person${++n}@example.com`, password = 'password123') {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name: 'Asha Rao', email, password });
  assert.equal(res.status, 201);
  call.email = email;
  return call;
}

const lastMailTo = (email) => t.mail.sent.findLast((m) => m.to.email === email);
const tokenIn = (mail) => mail.text.match(/\/confirm-email#token=([\w-]+)/)[1];
const change = (call, newEmail, password = 'password123') => call('POST', '/account/email', { newEmail, password });

test('changing the email needs a login, the password and a valid, unused new address', async () => {
  const call = await register();
  assert.equal((await t.call('POST', '/account/email', { newEmail: 'x@example.com', password: 'x' })).status, 401);
  assert.equal((await t.call('GET', '/account/email')).status, 401);

  const wrong = await change(call, 'new@example.com', 'not my password');
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, 'Your password is wrong');
  assert.equal((await change(call, 'not-an-email')).status, 400);
  const same = await change(call, call.email.toUpperCase());
  assert.equal(same.status, 400);
  assert.equal(same.body.error, "That's already your email");
  const other = await register();
  const taken = await change(call, other.email);
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error, 'An account with this email already exists');
  // Nothing was sent for any of these.
  assert.equal((await call('GET', '/account/email')).body.pendingEmail, null);
});

test('the link sent to the new address changes the email; the old address is told', async () => {
  const call = await register();
  const oldEmail = call.email;
  const res = await change(call, ' Asha.New@Example.com ');
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { pendingEmail: 'asha.new@example.com' });

  // Until confirmed, nothing changes: the old email still logs in and the change shows as waiting.
  const status = (await call('GET', '/account/email')).body;
  assert.equal(status.pendingEmail, 'asha.new@example.com');
  assert.ok(new Date(status.expiresAt) > new Date(Date.now() + 23 * 3_600_000));
  assert.equal((await call('GET', '/auth/me')).body.user.email, oldEmail);

  const mail = lastMailTo('asha.new@example.com');
  assert.equal(mail.subject, 'Confirm your new Bazaar email');
  assert.match(mail.text, /^Hi Asha,/);
  assert.match(mail.text, /https:\/\/bazaar\.test\/confirm-email#token=/);
  assert.match(mail.text, new RegExp(`Until then you keep logging in with ${oldEmail}`));

  // Confirmed from another device, not logged in: it works, but returns no account details there.
  const elsewhere = t.browser();
  const confirmed = await elsewhere('POST', '/auth/confirm-email', { token: tokenIn(mail) });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(confirmed.body, { email: 'asha.new@example.com', user: null });

  // The session stays logged in, now with the new email; only the new email logs in.
  assert.equal((await call('GET', '/auth/me')).body.user.email, 'asha.new@example.com');
  const login = (email) => t.browser()('POST', '/auth/login', { email, password: 'password123' });
  assert.equal((await login('asha.new@example.com')).status, 200);
  assert.equal((await login(oldEmail)).status, 401);

  const notice = lastMailTo(oldEmail);
  assert.equal(notice.subject, 'Your Bazaar email was changed');
  assert.match(notice.text, new RegExp(`changed from ${oldEmail} to asha\\.new@example\\.com`));
  assert.equal((await call('GET', '/account/email')).body.pendingEmail, null);

  // The link works once.
  const again = await elsewhere('POST', '/auth/confirm-email', { token: tokenIn(mail) });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /expired or was already used/);
});

test('confirming while logged in returns the updated account', async () => {
  const call = await register();
  await change(call, `logged-in-${n}@example.com`);
  const res = await call('POST', '/auth/confirm-email', { token: tokenIn(lastMailTo(`logged-in-${n}@example.com`)) });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, `logged-in-${n}@example.com`);
});

test('a newer request or a cancel stops the older link; links expire', async () => {
  const call = await register();
  await change(call, 'first-choice@example.com');
  const first = tokenIn(lastMailTo('first-choice@example.com'));
  await change(call, 'second-choice@example.com');
  const second = tokenIn(lastMailTo('second-choice@example.com'));
  assert.equal((await call('GET', '/account/email')).body.pendingEmail, 'second-choice@example.com');
  assert.equal((await t.call('POST', '/auth/confirm-email', { token: first })).status, 400);

  assert.equal((await call('DELETE', '/account/email')).status, 204);
  assert.equal((await call('GET', '/account/email')).body.pendingEmail, null);
  assert.equal((await t.call('POST', '/auth/confirm-email', { token: second })).status, 400);

  // A day-old link no longer works.
  const other = await register();
  await change(other, 'too-late@example.com');
  await t.db
    .collection('emailChanges')
    .updateOne({ newEmail: 'too-late@example.com' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const late = await t.call('POST', '/auth/confirm-email', { token: tokenIn(lastMailTo('too-late@example.com')) });
  assert.equal(late.status, 400);
  assert.equal((await t.call('POST', '/auth/confirm-email', { token: 'x'.repeat(43) })).status, 400);
});

test('at most 3 confirmation emails an hour, even when sent at once', async () => {
  const racer = await register();
  const burst = await Promise.all(Array.from({ length: 5 }, (_, i) => change(racer, `burst${i}-${n}@example.com`)));
  assert.equal(burst.filter((r) => r.status === 201).length, 3);
  assert.equal(burst.filter((r) => r.status === 429).length, 2);

  const call = await register();
  for (let i = 0; i < 3; i++) assert.equal((await change(call, `try${i}-${n}@example.com`)).status, 201);
  const fourth = await change(call, `try3-${n}@example.com`);
  assert.equal(fourth.status, 429);
  assert.equal(lastMailTo(`try3-${n}@example.com`), undefined);
});

test('if the address is taken before the link is used, the change is refused', async () => {
  const call = await register();
  await change(call, 'contested@example.com');
  const token = tokenIn(lastMailTo('contested@example.com'));
  await register('contested@example.com');
  const res = await t.call('POST', '/auth/confirm-email', { token });
  assert.equal(res.status, 409);
  assert.equal((await call('GET', '/auth/me')).body.user.email, call.email);
});

test('reset links sent to the old address stop working after the change', async () => {
  const call = await register();
  const oldEmail = call.email;
  await t.call('POST', '/auth/forgot-password', { email: oldEmail });
  // The reset email is sent in the background.
  for (let i = 0; i < 50 && !lastMailTo(oldEmail); i++) await new Promise((r) => setTimeout(r, 20));
  const resetToken = lastMailTo(oldEmail).text.match(/#token=([\w-]+)/)[1];

  await change(call, `moved-${n}@example.com`);
  await t.call('POST', '/auth/confirm-email', { token: tokenIn(lastMailTo(`moved-${n}@example.com`)) });
  const reset = await t.call('POST', '/auth/reset-password', { token: resetToken, password: 'taken over 123' });
  assert.equal(reset.status, 400);
});

test("if the confirmation can't be sent, nothing is left pending", async () => {
  const call = await register();
  t.mail.failNext();
  const res = await change(call, `unsent-${n}@example.com`);
  assert.equal(res.status, 502);
  assert.equal(res.body.error, "We couldn't send the confirmation email. Try again in a moment.");
  assert.equal((await call('GET', '/account/email')).body.pendingEmail, null);
});

test('wrong passwords here count towards the login lock', async () => {
  const call = await register();
  for (let i = 0; i < 4; i++) assert.equal((await change(call, 'x@example.com', `wrong ${i}`)).status, 400);
  assert.equal((await change(call, 'x@example.com', 'wrong 4')).status, 429);
});
