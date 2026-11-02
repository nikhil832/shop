import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { codeFor, startFakeGoogle } from './fake-google.js';
import { safeNext } from '../src/googleLogin.js';

let t;
let google;
before(async () => {
  t = await startTestServer();
  google = await startFakeGoogle();
});
after(async () => {
  await google.stop();
  await t.stop();
});
beforeEach(async () => {
  t.ctx.config.google = google.config('https://bazaar.test/api/auth/google/callback');
  await t.db.collection('rateLimits').deleteMany({});
});

// Goes to Google (the redirect and its cookie), and comes back with `identity` (or `query` for the callback).
async function loginWithGoogle(call, identity, { next = '/orders', query } = {}) {
  const start = await call('GET', `/auth/google?next=${encodeURIComponent(next)}`);
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get('location'));
  const state = to.searchParams.get('state');
  const params = query ?? { state, code: codeFor(identity) };
  return call('GET', `/auth/google/callback?${new URLSearchParams(params)}`);
}
const hashOf = (res) => new URL(res.headers.get('location'), 'https://bazaar.test').hash;

test('the login page offers Google only when it is set up', async () => {
  assert.deepEqual((await t.call('GET', '/auth/options')).body, { google: true });
  t.ctx.config.google = null;
  assert.deepEqual((await t.call('GET', '/auth/options')).body, { google: false });
  assert.equal((await t.call('GET', '/auth/google')).status, 404);
});

test('the redirect asks Google for the openid email profile scopes with a state kept in a cookie', async () => {
  const call = t.browser();
  const res = await call('GET', '/auth/google?next=/wishlist');
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get('location'));
  assert.equal(`${to.origin}${to.pathname}`, `${google.url}/auth`);
  assert.equal(to.searchParams.get('client_id'), 'fake-client.apps.googleusercontent.com');
  assert.equal(to.searchParams.get('redirect_uri'), 'https://bazaar.test/api/auth/google/callback');
  assert.equal(to.searchParams.get('scope'), 'openid email profile');
  assert.equal(to.searchParams.get('response_type'), 'code');
  assert.ok(to.searchParams.get('state').length >= 32);
  assert.ok(!to.toString().includes('fake-secret'));
  assert.match(res.setCookie, /bazaar_google=.*HttpOnly/i);
  assert.match(res.setCookie, /Path=\/api\/auth\/google/);
});

test('a new Google user gets an account without a password and is logged in', async () => {
  const call = t.browser();
  const res = await loginWithGoogle(call, { email: 'Meera@Example.com', name: 'Meera Iyer', sub: 'g-meera' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/orders');
  const me = (await call('GET', '/auth/me')).body.user;
  assert.equal(me.email, 'meera@example.com');
  assert.equal(me.name, 'Meera Iyer');
  assert.equal(me.google, true);
  assert.equal(me.hasPassword, false);
  // The secret went to the token endpoint, never to the browser.
  assert.equal(google.state.exchanges.at(-1).client_secret, 'fake-secret');

  // Next time, the same Google account finds the same account, even if Google's email changed.
  const again = t.browser();
  await loginWithGoogle(again, { email: 'meera.new@example.com', name: 'Meera', sub: 'g-meera' });
  assert.equal((await again('GET', '/auth/me')).body.user.email, 'meera@example.com');
  assert.equal(await t.db.collection('users').countDocuments({ googleId: 'g-meera' }), 1);
});

test('an existing account with that email is linked, and can unlink once it has a password', async () => {
  const call = t.browser();
  await call('POST', '/auth/register', { name: 'Ravi Kumar', email: 'ravi@example.com', password: 'password123' });
  await call('POST', '/auth/logout');
  const res = await loginWithGoogle(call, { email: 'ravi@example.com', sub: 'g-ravi' });
  assert.equal(res.headers.get('location'), '/orders');
  const me = (await call('GET', '/auth/me')).body.user;
  assert.equal(me.name, 'Ravi Kumar');
  assert.equal(me.google, true);

  // A second Google account with the same email can't take it over.
  const other = t.browser();
  const refused = await loginWithGoogle(other, { email: 'ravi@example.com', sub: 'g-someone-else' });
  assert.equal(hashOf(refused), '#google-error=other-google');
  assert.equal((await other('GET', '/auth/me')).body.user, null);

  const unlinked = await call('DELETE', '/account/google');
  assert.equal(unlinked.status, 200);
  assert.equal(unlinked.body.user.google, false);
  // A Google-only account can't unlink: it would have no way in.
  const only = t.browser();
  await loginWithGoogle(only, { email: 'only@example.com', sub: 'g-only' });
  assert.equal((await only('DELETE', '/account/google')).status, 409);
});

test('two-step accounts still need their code', async () => {
  const call = t.browser();
  await call('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
  await t.db
    .collection('users')
    .updateOne(
      { email: 'asha@example.com' },
      { $set: { totp: { secret: 'JBSWY3DPEHPK3PXP', enabledAt: new Date(), lastStep: 0, recoveryHashes: [] } } },
    );
  await call('POST', '/auth/logout');
  const res = await loginWithGoogle(call, { email: 'asha@example.com', sub: 'g-asha' }, { next: '/account' });
  const location = res.headers.get('location');
  assert.match(location, /^\/login\?next=%2Faccount#google-ticket=[\w-]+$/);
  assert.equal((await call('GET', '/auth/me')).body.user, null);
  const ticket = location.split('google-ticket=')[1];
  assert.ok(await t.db.collection('loginChallenges').countDocuments({}));
  assert.equal((await call('POST', '/auth/login/code', { ticket, code: '000000' })).status, 401);
});

test('cancelled, expired, unverified and refused logins go back to the login page with a reason', async () => {
  const cases = [
    [{ query: { error: 'access_denied', state: 'x' } }, 'cancelled'],
    [{ query: { state: 'not-ours', code: codeFor({ email: 'x@example.com' }) } }, 'expired'],
    [{ query: { code: 'bad' }, keepState: true }, 'failed'],
    [{ identity: { email: 'x@example.com', email_verified: false } }, 'unverified'],
    [{ identity: { email: 'x@example.com', expired: true } }, 'failed'],
    [{ identity: { email: 'x@example.com', aud: 'someone-elses-client' } }, 'failed'],
  ];
  for (const [{ identity, query, keepState }, reason] of cases) {
    const call = t.browser();
    let res;
    if (keepState) {
      const start = await call('GET', '/auth/google');
      const state = new URL(start.headers.get('location')).searchParams.get('state');
      res = await call('GET', `/auth/google/callback?${new URLSearchParams({ ...query, state })}`);
    } else {
      res = await loginWithGoogle(call, identity, { query });
    }
    assert.equal(res.status, 302);
    assert.equal(hashOf(res), `#google-error=${reason}`, JSON.stringify({ identity, query }));
    assert.equal((await call('GET', '/auth/me')).body.user, null);
  }
  // Without the cookie (another browser), even a right state is refused.
  const a = t.browser();
  const start = await a('GET', '/auth/google');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const b = t.browser();
  const res = await b(
    'GET',
    `/auth/google/callback?${new URLSearchParams({ state, code: codeFor({ email: 'y@example.com' }) })}`,
  );
  assert.equal(hashOf(res), '#google-error=expired');
});

test('only paths on this site are followed after logging in', async () => {
  assert.equal(safeNext('/orders?x=1'), '/orders?x=1');
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'orders', '/a b', null]) {
    assert.equal(safeNext(bad), '/', String(bad));
  }
  const call = t.browser();
  const res = await loginWithGoogle(call, { email: 'n@example.com' }, { next: '//evil.example/x' });
  assert.equal(res.headers.get('location'), '/');
});
