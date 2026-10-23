import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { base32Decode, base32Encode, codeAt, stepOf, verifyCode } from '../src/totp.js';
import { startTestServer } from './helpers.js';

let t;
before(async () => (t = await startTestServer()));
after(() => t.stop());

let n = 0;
async function register() {
  const email = `two-step${++n}@example.com`;
  const call = t.browser();
  assert.equal(
    (await call('POST', '/auth/register', { name: 'Asha Rao', email, password: 'password123' })).status,
    201,
  );
  call.email = email;
  return call;
}
const now =
  (offset = 0) =>
  (secret) =>
    codeAt(secret, stepOf() + offset);

// Turns two-step login on for a logged-in `call`; returns the secret and the recovery codes.
async function enable(call) {
  const setup = await call('POST', '/account/two-step/setup', { password: 'password123' });
  assert.equal(setup.status, 200);
  const res = await call('POST', '/account/two-step/enable', { code: now()(setup.body.secret) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { secret: setup.body.secret, recoveryCodes: res.body.recoveryCodes, uri: setup.body.uri };
}
const login = (call, password = 'password123') => call('POST', '/auth/login', { email: call.email, password });

test('codes match the RFC 6238 test values, and base32 round-trips', () => {
  // The RFC's SHA-1 secret is the ASCII "12345678901234567890"; its test codes are 8 digits.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  for (const [time, code] of [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ]) {
    assert.equal(codeAt(secret, Math.floor(time / 30), 8), code, String(time));
  }
  assert.deepEqual(base32Decode(base32Encode(Buffer.from([0, 1, 254, 255, 7]))), Buffer.from([0, 1, 254, 255, 7]));
  // One step either side is accepted (clocks a little off); further, or an already used step, is not.
  const time = 1_700_000_000_000;
  const step = stepOf(time);
  assert.equal(verifyCode(secret, codeAt(secret, step - 1), { time }), step - 1);
  assert.equal(verifyCode(secret, codeAt(secret, step + 1), { time }), step + 1);
  assert.equal(verifyCode(secret, codeAt(secret, step + 2), { time }), null);
  assert.equal(verifyCode(secret, codeAt(secret, step), { time, lastStep: step }), null);
  assert.equal(verifyCode(secret, 'abcdef', { time }), null);
});

test('setting it up needs the password and a code from the app; recovery codes are shown once', async () => {
  const call = await register();
  const other = t.browser();
  other.email = call.email;
  assert.equal((await login(other)).status, 200); // a second device, logged out when it's turned on

  assert.equal((await call('POST', '/account/two-step/setup', { password: 'wrong' })).status, 400);
  const setup = await call('POST', '/account/two-step/setup', { password: 'password123' });
  assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
  assert.equal(
    setup.body.uri,
    `otpauth://totp/Bazaar%3A${encodeURIComponent(call.email)}?secret=${setup.body.secret}&issuer=Bazaar&algorithm=SHA1&digits=6&period=30`,
  );
  // Not on until a code confirms it.
  assert.equal((await call('GET', '/auth/me')).body.user.twoStep, false);
  const wrong = await call('POST', '/account/two-step/enable', { code: '000000' });
  assert.equal(wrong.status, 400);

  const res = await call('POST', '/account/two-step/enable', { code: now()(setup.body.secret) });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.twoStep, true);
  assert.equal(res.body.recoveryCodes.length, 8);
  assert.ok(res.body.recoveryCodes.every((c) => /^[a-z2-9]{4}-[a-z2-9]{4}$/.test(c)));
  // Stored as hashes only; the setup secret is gone.
  const stored = await t.db.collection('users').findOne({ email: call.email });
  assert.equal(stored.totpSetup, undefined);
  assert.ok(!JSON.stringify(stored.totp.recoveryHashes).includes(res.body.recoveryCodes[0]));
  // This device stays logged in; the other one is logged out.
  assert.equal((await call('GET', '/auth/me')).body.user.email, call.email);
  assert.equal((await other('GET', '/auth/me')).body.user, null);
  assert.equal((await call('POST', '/account/two-step/setup', { password: 'password123' })).status, 409);
});

test('logging in then takes the password and a code, each code once; recovery codes work once each', async () => {
  const owner = await register();
  const { secret, recoveryCodes } = await enable(owner);
  const call = t.browser();
  call.email = owner.email;

  const first = await login(call);
  assert.equal(first.status, 200);
  assert.equal(first.body.user, null);
  assert.equal(first.body.twoStep, true);
  assert.equal(first.setCookie, null); // no session from the password alone
  assert.equal((await call('GET', '/auth/me')).body.user, null);

  const wrong = await call('POST', '/auth/login/code', { ticket: first.body.ticket, code: '123456' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, 'That code is wrong or was already used');
  // The setup used the current code, so it can't be used again: the next one works.
  assert.equal(
    (await call('POST', '/auth/login/code', { ticket: first.body.ticket, code: now()(secret) })).status,
    401,
  );
  const ok = await call('POST', '/auth/login/code', { ticket: first.body.ticket, code: now(1)(secret) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.email, owner.email);
  assert.match(ok.setCookie, /^sid=/);
  // A ticket works once.
  assert.equal(
    (await call('POST', '/auth/login/code', { ticket: first.body.ticket, code: now(1)(secret) })).status,
    400,
  );

  // A recovery code, in any case and with spaces, once.
  const another = t.browser();
  another.email = owner.email;
  const ticket = (await login(another)).body.ticket;
  const viaRecovery = await another('POST', '/auth/login/code', {
    ticket,
    code: ` ${recoveryCodes[0].toUpperCase()} `,
  });
  assert.equal(viaRecovery.status, 200);
  assert.equal(viaRecovery.body.recoveryCodesLeft, 7);
  const again = t.browser();
  again.email = owner.email;
  const ticket2 = (await login(again)).body.ticket;
  assert.equal((await again('POST', '/auth/login/code', { ticket: ticket2, code: recoveryCodes[0] })).status, 401);

  // Five wrong codes end the ticket (the reused recovery code above was the first).
  for (let i = 0; i < 3; i++) {
    assert.equal((await again('POST', '/auth/login/code', { ticket: ticket2, code: '000000' })).status, 401);
  }
  const locked = await again('POST', '/auth/login/code', { ticket: ticket2, code: '000000' });
  assert.equal(locked.status, 429);
  assert.equal((await again('POST', '/auth/login/code', { ticket: ticket2, code: now(1)(secret) })).status, 400);

  // An expired ticket is refused; a wrong password still gets no ticket.
  const late = (await login(again)).body.ticket;
  await t.db.collection('loginChallenges').updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await again('POST', '/auth/login/code', { ticket: late, code: now(1)(secret) });
  assert.equal(expired.status, 400);
  assert.equal(expired.body.error, 'This login has expired. Log in again.');
  assert.equal((await login(again, 'wrong password')).status, 401);
});

test('a password reset link changes the password but still leaves the code to log in', async () => {
  const owner = await register();
  await enable(owner);
  await t.call('POST', '/auth/forgot-password', { email: owner.email });
  let mail;
  for (let i = 0; i < 50 && !mail; i++) {
    mail = t.mail.sent.findLast((m) => m.to.email === owner.email && m.subject.startsWith('Reset'));
    if (!mail) await new Promise((r) => setTimeout(r, 20));
  }
  const token = mail.text.match(/#token=([\w-]+)/)[1];
  const browser = t.browser();
  const res = await browser('POST', '/auth/reset-password', { token, password: 'a new password 1' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { user: null, twoStep: true });
  assert.equal(res.setCookie, null);
  browser.email = owner.email;
  assert.equal((await login(browser, 'a new password 1')).body.twoStep, true);
});

test('turning it off needs the password and a code; recovery codes can be replaced', async () => {
  const call = await register();
  const { secret, recoveryCodes } = await enable(call);

  const fresh = await call('POST', '/account/two-step/recovery-codes', { code: now(1)(secret) });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.recoveryCodes.length, 8);
  // The old codes no longer work; a recovery code can't make new ones.
  const off1 = await call('POST', '/account/two-step/disable', { password: 'password123', code: recoveryCodes[1] });
  assert.equal(off1.status, 400);
  assert.equal(
    (await call('POST', '/account/two-step/recovery-codes', { code: fresh.body.recoveryCodes[0] })).status,
    400,
  );

  assert.equal(
    (await call('POST', '/account/two-step/disable', { password: 'wrong', code: fresh.body.recoveryCodes[1] })).status,
    400,
  );
  const off = await call('POST', '/account/two-step/disable', {
    password: 'password123',
    code: fresh.body.recoveryCodes[1],
  });
  assert.equal(off.status, 200);
  assert.equal(off.body.user.twoStep, false);
  const plain = t.browser();
  plain.email = call.email;
  assert.equal((await login(plain)).body.user.email, call.email);
});

test('npm run reset-two-step switches it off for a lost phone, and logs the account out everywhere', async () => {
  const call = await register();
  await enable(call);
  const run = (email) =>
    spawnSync(process.execPath, ['src/reset-two-step.js', email], {
      cwd: new URL('..', import.meta.url),
      // The test's own in-memory database: env vars win over server/.env, so Atlas is never touched.
      env: { PATH: process.env.PATH, MONGODB_URI: t.uri, MONGODB_DB: t.db.databaseName },
      encoding: 'utf8',
    });
  const res = run(call.email);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Two-step login is off for .+, and it is logged out everywhere/);
  assert.equal((await call('GET', '/auth/me')).body.user, null);
  const plain = t.browser();
  plain.email = call.email;
  assert.equal((await login(plain)).body.user.twoStep, false);
  assert.match(run(call.email).stdout, /doesn't have two-step login on/);
  assert.equal(run('nobody@example.com').status, 1);
});
