import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.deepEqual(Object.keys(res.body.user).sort(), ['address', 'email', 'id', 'name', 'role']);
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
