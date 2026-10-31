import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { hashToken, networkOf } from '../src/auth.js';
import { startTestServer } from './helpers.js';

let t;
before(async () => (t = await startTestServer()));
after(() => t.stop());

const account = { name: 'Asha Rao', email: 'Asha@Example.com', password: 'correct horse' };

test('registers, stays logged in with the cookie, and logs out', async () => {
  const call = t.browser();
  assert.deepEqual((await call('GET', '/auth/me')).body, { user: null });

  const res = await call('POST', '/auth/register', account);
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(res.body.user).sort(), [
    'address',
    'addresses',
    'cartReminderEmails',
    'credit',
    'email',
    'hasPassword',
    'id',
    'name',
    'permissions',
    'priceDropEmails',
    'restockReminderEmails',
    'reviewReminderEmails',
    'role',
    'twoStep',
  ]);
  assert.equal(res.body.user.email, 'asha@example.com');
  assert.equal(res.body.user.role, 'user');
  assert.match(res.setCookie, /^sid=[\w-]{43}; Max-Age=2592000; Path=\/; Expires=.+; HttpOnly; SameSite=Lax$/);

  const me = await call('GET', '/auth/me');
  assert.equal(me.body.user.name, 'Asha Rao');

  // The password and the raw session token are never stored.
  const user = await t.db.collection('users').findOne({ email: 'asha@example.com' });
  assert.match(user.passwordHash, /^scrypt\$/);
  assert.ok(!user.passwordHash.includes(account.password));
  const token = res.setCookie.split(';')[0].slice(4);
  assert.equal(await t.db.collection('sessions').countDocuments({ tokenHash: token }), 0);
  assert.equal(await t.db.collection('sessions').countDocuments({ userId: user._id }), 1);

  const out = await call('POST', '/auth/logout');
  assert.equal(out.status, 204);
  assert.match(out.setCookie, /^sid=;/);
  assert.equal(await t.db.collection('sessions').countDocuments({ userId: user._id }), 0);
  assert.deepEqual((await call('GET', '/auth/me')).body, { user: null });
});

test('logs in with the right password only, ignoring email case', async () => {
  const call = t.browser();
  const wrong = await call('POST', '/auth/login', { email: 'asha@example.com', password: 'wrong password' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, 'Wrong email or password');
  assert.equal(wrong.setCookie, null);

  const unknown = await call('POST', '/auth/login', { email: 'nobody@example.com', password: 'whatever1' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error, 'Wrong email or password');

  const ok = await call('POST', '/auth/login', { email: ' ASHA@example.COM ', password: account.password });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.name, 'Asha Rao');
  assert.equal((await call('GET', '/auth/me')).body.user.email, 'asha@example.com');
});

test('refuses a second account with the same email', async () => {
  const res = await t.browser()('POST', '/auth/register', { ...account, email: 'ASHA@example.com' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'An account with this email already exists');
});

test('validates registration and login input', async () => {
  const call = t.browser();
  const cases = [
    [{ ...account, name: ' ' }, /^name: Enter your name$/],
    [{ ...account, email: 'not-an-email' }, /^email: Enter a valid email$/],
    [{ ...account, password: 'short' }, /^password: Password must be at least 8 characters$/],
    [{ name: 'X', email: 'x@example.com' }, /^password:/],
    [{ ...account, role: 'admin', email: 'sneaky@example.com', password: 'x' }, /^password:/],
  ];
  for (const [body, error] of cases) {
    const res = await call('POST', '/auth/register', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, error);
  }
  assert.equal((await call('POST', '/auth/login', { email: 'asha@example.com' })).status, 400);
});

test('cannot register as admin through the API', async () => {
  const res = await t.browser()('POST', '/auth/register', {
    name: 'Mallory',
    email: 'mallory@example.com',
    password: 'password123',
    role: 'admin',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.role, 'user');
});

test('ignores unknown and expired session cookies', async () => {
  const call = t.browser();
  await call('POST', '/auth/login', { email: 'asha@example.com', password: account.password });
  await t.db.collection('sessions').updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.deepEqual((await call('GET', '/auth/me')).body, { user: null });
  assert.equal((await call('GET', '/orders')).status, 401);
});

test('marks the session cookie Secure behind an HTTPS proxy', async () => {
  const res = await fetch(`${t.base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /; Secure; /);
});

test('answers the health check', async () => {
  const res = await t.call('GET', '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

// The reset email is sent in the background (so the reply's timing reveals nothing); wait for it.
async function resetMailTo(email, count = 1) {
  for (let i = 0; i < 100; i++) {
    const mails = t.mail.sent.filter((m) => m.to.email === email && m.subject === 'Reset your Bazaar password');
    if (mails.length >= count) return mails.at(-1);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No reset email for ${email}`);
}
const tokenIn = (mail) => mail.text.match(/\/reset-password#token=([\w-]{43})/)[1];

test('a password reset link sets a new password once, and logs out every other device', async () => {
  const email = 'reset1@example.com';
  const other = t.browser(); // already logged in elsewhere
  assert.equal(
    (await other('POST', '/auth/register', { name: 'Ravi Kumar', email, password: 'old password' })).status,
    201,
  );

  const call = t.browser();
  assert.equal((await call('POST', '/auth/forgot-password', { email: 'Reset1@Example.com' })).status, 204);
  const mail = await resetMailTo(email);
  assert.match(mail.text, /^Hi Ravi,/);
  assert.match(mail.text, /https:\/\/bazaar\.test\/reset-password#token=/);
  const token = tokenIn(mail);
  // Only a hash is stored.
  assert.equal(await t.db.collection('passwordResets').countDocuments({ tokenHash: token }), 0);

  assert.equal((await call('POST', '/auth/reset-password', { token, password: 'short' })).status, 400);
  const res = await call('POST', '/auth/reset-password', { token, password: 'new password' });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, email);
  assert.equal((await call('GET', '/auth/me')).body.user.email, email); // logged in here

  assert.deepEqual((await other('GET', '/auth/me')).body, { user: null }); // and out everywhere else
  assert.equal((await t.call('POST', '/auth/login', { email, password: 'old password' })).status, 401);
  assert.equal((await t.call('POST', '/auth/login', { email, password: 'new password' })).status, 200);

  const again = await call('POST', '/auth/reset-password', { token, password: 'another password' });
  assert.equal(again.status, 400);
  assert.equal(again.body.error, 'This reset link has expired or was already used. Ask for a new one.');
});

test('a reset request for an unknown email gets the same answer and sends nothing', async () => {
  const before = t.mail.sent.length;
  const res = await t.call('POST', '/auth/forgot-password', { email: 'nobody@example.com' });
  assert.equal(res.status, 204);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(t.mail.sent.length, before);
  assert.equal((await t.call('POST', '/auth/forgot-password', { email: 'not an email' })).status, 400);
});

test('reset links expire, malformed ones are refused, and only 3 are sent an hour', async () => {
  const email = 'reset2@example.com';
  await t.browser()('POST', '/auth/register', { name: 'Meera', email, password: 'password123' });
  await t.call('POST', '/auth/forgot-password', { email });
  const token = tokenIn(await resetMailTo(email));

  await t.db.collection('passwordResets').updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await t.call('POST', '/auth/reset-password', { token, password: 'new password' })).status, 400);
  const bad = await t.call('POST', '/auth/reset-password', { token: 'abc', password: 'new password' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'This reset link has expired or was already used. Ask for a new one.');

  // Sent at once (the emails go out in the background, so they would race): still only 3 links in all.
  await Promise.all(Array.from({ length: 5 }, () => t.call('POST', '/auth/forgot-password', { email })));
  await resetMailTo(email, 3);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const sent = t.mail.sent.filter((m) => m.to.email === email).length;
  assert.equal(sent, 3);
  assert.equal(await t.db.collection('passwordResets').countDocuments({ expiresAt: { $gt: new Date() } }), 2);
});

const LOCKED = 'Too many wrong passwords for this email. Try again in 15 minutes, or reset your password.';
const login = (email, password) => t.call('POST', '/auth/login', { email, password });

test('5 wrong passwords pause login for that email, even with the right password', async () => {
  const email = 'locked1@example.com';
  await t.browser()('POST', '/auth/register', { name: 'Lata', email, password: 'right password' });

  for (let i = 0; i < 4; i++) assert.equal((await login(email, `wrong ${i}`)).status, 401);
  const fifth = await login(email, 'wrong 4');
  assert.equal(fifth.status, 429);
  assert.equal(fifth.body.error, LOCKED);
  const right = await login(email, 'right password');
  assert.equal(right.status, 429);
  assert.equal(right.setCookie, null);

  // Other accounts are unaffected, and the lock ends once the attempts are 15 minutes old.
  assert.equal((await login('asha@example.com', 'wrong')).status, 401);
  const old = new Date(Date.now() - 16 * 60_000);
  await t.db.collection('loginAttempts').updateMany({}, { $set: { at: old } });
  assert.equal((await login(email, 'right password')).status, 200);
});

test('unknown emails lock the same way, and attempts sent at once still count', async () => {
  await t.db.collection('loginAttempts').deleteMany({}); // only this test's attempts below
  // However the attempts arrive, at most 5 passwords are checked: at most 4 "wrong" answers, then the lock. (Attempts
  // sent at once can see each other before the extra ones are removed, so the lock may even come sooner.)
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => login('ghost@example.com', `guess ${i}`)));
  const statuses = burst.map((r) => r.status);
  // Then one at a time until the lock answers.
  for (let i = 0; i < 10; i++) {
    const { status } = await login('ghost@example.com', 'again');
    statuses.push(status);
    if (status === 429) break;
  }
  assert.ok(statuses.filter((s) => s === 401).length <= 4);
  assert.equal(statuses.at(-1), 429);
  // Refused attempts aren't kept, so retrying while locked doesn't stretch the lock.
  const key = hashToken('login:ghost@example.com');
  assert.ok((await t.db.collection('loginAttempts').countDocuments({ key })) <= 5);
  await t.db.collection('loginAttempts').deleteMany({});
});

test('a successful login clears earlier wrong passwords', async () => {
  const email = 'locked2@example.com';
  await t.browser()('POST', '/auth/register', { name: 'Lata', email, password: 'right password' });
  for (let i = 0; i < 4; i++) await login(email, 'wrong');
  assert.equal((await login(email, 'right password')).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await login(email, 'wrong')).status, 401);
});

test('a password reset ends a lock, and must choose a different password', async () => {
  const email = 'locked3@example.com';
  await t.browser()('POST', '/auth/register', { name: 'Lata', email, password: 'right password' });
  for (let i = 0; i < 5; i++) await login(email, 'wrong');
  assert.equal((await login(email, 'right password')).status, 429);

  await t.call('POST', '/auth/forgot-password', { email });
  const token = tokenIn(await resetMailTo(email));
  const call = t.browser();
  const same = await call('POST', '/auth/reset-password', { token, password: 'right password' });
  assert.equal(same.status, 400);
  assert.equal(same.body.error, 'Your new password must be different from your current one.');
  // The link still works for a different password, which also unlocks login.
  assert.equal((await call('POST', '/auth/reset-password', { token, password: 'brand new password' })).status, 200);
  assert.equal((await login(email, 'brand new password')).status, 200);
});

// A login from a given visitor address, as the host's edge reports it in CF-Connecting-IP.
async function loginFrom(ip, email, password) {
  const res = await fetch(`${t.base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, body: await res.json() };
}
const NETWORK_LOCKED = 'Too many wrong passwords from your network. Try again in 15 minutes.';

test('20 wrong passwords from one network, across any emails, pause login from that network only', async () => {
  await t.db.collection('loginAttempts').deleteMany({});
  t.ctx.config.clientIpHeader = 'cf-connecting-ip';
  try {
    const email = 'spray-target@example.com';
    await t.browser()('POST', '/auth/register', { name: 'Lata', email, password: 'right password' });
    // One common password tried on 20 different accounts (4 each, so no email lock), from one address.
    for (let i = 0; i < 20; i++) {
      assert.equal((await loginFrom('203.0.113.7', `user${i % 5}@example.com`, 'password123')).status, 401, `try ${i}`);
    }
    const blocked = await loginFrom('203.0.113.7', 'user9@example.com', 'password123');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, NETWORK_LOCKED);
    // Even the right password, so the network learns nothing while it's paused.
    assert.equal((await loginFrom('203.0.113.7', email, 'right password')).status, 429);
    // Another network, and the same email from it, are unaffected.
    assert.equal((await loginFrom('198.51.100.20', email, 'right password')).status, 200);

    // The pause ends once the attempts are 15 minutes old.
    const old = new Date(Date.now() - 16 * 60_000);
    await t.db.collection('loginAttempts').updateMany({}, { $set: { at: old } });
    assert.equal((await loginFrom('203.0.113.7', email, 'right password')).status, 200);
  } finally {
    t.ctx.config.clientIpHeader = null;
    await t.db.collection('loginAttempts').deleteMany({});
  }
});

test("logging in to one's own account doesn't clear the network's wrong passwords", async () => {
  t.ctx.config.clientIpHeader = 'cf-connecting-ip';
  try {
    const email = 'own-account@example.com';
    await t.browser()('POST', '/auth/register', { name: 'Lata', email, password: 'right password' });
    for (let i = 0; i < 20; i++) {
      await loginFrom('203.0.113.8', `other${i % 5}@example.com`, 'guess');
      // An attacker logging in to their own account between guesses gains nothing.
      // (Not after the 20th, when the network is already paused.)
      if (i % 5 === 4 && i < 19) {
        assert.equal((await loginFrom('203.0.113.8', email, 'right password')).status, 200);
      }
    }
    assert.equal((await loginFrom('203.0.113.8', 'other9@example.com', 'guess')).status, 429);
  } finally {
    t.ctx.config.clientIpHeader = null;
    await t.db.collection('loginAttempts').deleteMany({});
  }
});

test('one IPv6 /64 counts as one network; a header that is not an address is ignored', async () => {
  assert.equal(networkOf('2405:201:abcd:12:aaaa::1'), '2405:201:abcd:12::/64');
  assert.equal(networkOf('2405:0201:abcd:0012:ffff:1:2:3'), '2405:201:abcd:12::/64');
  assert.equal(networkOf('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(networkOf('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(networkOf('203.0.113.7'), '203.0.113.7');
  assert.equal(networkOf(undefined), 'unknown');

  t.ctx.config.clientIpHeader = 'cf-connecting-ip';
  try {
    for (let i = 0; i < 20; i++) await loginFrom(`2405:201:abcd:12::${i + 1}`, `v6-${i % 5}@example.com`, 'guess');
    assert.equal((await loginFrom('2405:201:abcd:12:ffff::9', 'v6-9@example.com', 'guess')).status, 429);
    assert.equal((await loginFrom('2405:201:abcd:13::1', 'v6-9@example.com', 'guess')).status, 401);
    // Not an address: falls back to the connection's own address (here, the test's 127.0.0.1), not a made-up network.
    assert.equal((await loginFrom('not-an-ip', 'v6-9@example.com', 'guess')).status, 401);
  } finally {
    t.ctx.config.clientIpHeader = null;
    await t.db.collection('loginAttempts').deleteMany({});
  }
});
