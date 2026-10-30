import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
before(async () => {
  t = await startTestServer();
  const call = t.browser();
  await call('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
});
after(() => t.stop());
beforeEach(() => t.db.collection('rateLimits').deleteMany({}));

// Asks for a code and waits for the email (sent in the background), returning the code from its subject.
async function askCode(call, email = 'asha@example.com') {
  const before = t.mail.sent.length;
  assert.equal((await call('POST', '/auth/email-code', { email })).status, 204);
  for (let i = 0; i < 50 && t.mail.sent.length === before; i++) await new Promise((r) => setTimeout(r, 20));
  const mail = t.mail.sent.slice(before).find((m) => m.to.email === email);
  return mail?.subject.match(/^(\d{6}) is your Bazaar login code$/)?.[1] ?? null;
}
const logIn = (call, code, email = 'asha@example.com') => call('POST', '/auth/email-code/login', { email, code });

test('an emailed code logs in once; unknown emails get the same answer and no email', async () => {
  const call = t.browser();
  const before = t.mail.sent.length;
  assert.equal((await call('POST', '/auth/email-code', { email: 'nobody@example.com' })).status, 204);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(t.mail.sent.length, before);

  const code = await askCode(call);
  assert.match(code, /^\d{6}$/);
  const mail = t.mail.sent.at(-1);
  assert.match(mail.text, /It works once, for 10 minutes/);
  const res = await logIn(call, code);
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, 'asha@example.com');
  assert.equal((await call('GET', '/auth/me')).body.user.email, 'asha@example.com');
  assert.equal((await logIn(t.browser(), code)).status, 400); // used up
  assert.equal(await t.db.collection('loginCodes').countDocuments(), 0);
});

test('wrong codes are limited, a newer code replaces the old one, and emails are limited per hour', async () => {
  const call = t.browser();
  const first = await askCode(call);
  const second = await askCode(call);
  // The older code no longer works: it reads as a wrong one (the first of five).
  assert.equal((await logIn(call, first === second ? '000000' : first)).status, 401);
  const wrong = second === '123456' ? '654321' : '123456';
  for (let i = 2; i < 5; i++) assert.equal((await logIn(call, wrong)).status, 401);
  assert.equal((await logIn(call, wrong)).status, 429); // the fifth: the code is gone
  assert.equal((await logIn(call, second)).status, 400);
  assert.equal((await logIn(call, '12')).status, 400);

  // Three emails an hour: the fourth ask sends nothing (and still answers 204).
  await askCode(call);
  assert.equal(await askCode(call), null);
});

test('one network may try 30 codes an hour, whatever the account', async () => {
  const call = t.browser();
  for (let i = 0; i < 30; i++) await logIn(call, '111111', `someone${i}@example.com`);
  assert.equal((await logIn(call, '111111')).status, 429);
});

test('with two-step login on, the code earns a ticket; accounts without a password can use codes', async () => {
  await t.db
    .collection('users')
    .updateOne(
      { email: 'asha@example.com' },
      { $set: { totp: { secret: 'JBSWY3DPEHPK3PXP', enabledAt: new Date(), lastStep: 0, recoveryHashes: [] } } },
    );
  const call = t.browser();
  const res = await logIn(call, await askCode(call));
  assert.equal(res.body.twoStep, true);
  assert.ok(res.body.ticket);
  assert.equal((await call('GET', '/auth/me')).body.user, null);

  const guest = t.browser();
  assert.equal(
    (await guest('POST', '/auth/quick-account', { name: 'Ravi Kumar', email: 'ravi@example.com' })).status,
    201,
  );
  await guest('POST', '/auth/logout');
  const code = await askCode(guest, 'ravi@example.com');
  assert.equal((await logIn(guest, code, 'ravi@example.com')).body.user.email, 'ravi@example.com');
});
