import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
before(async () => (t = await startTestServer()));
after(() => t.stop());

let n = 0;
async function register(password = 'password123') {
  const email = `account${++n}@example.com`;
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name: 'Asha Rao', email, password })).status, 201);
  call.email = email;
  return call;
}

test('account routes need a login', async () => {
  for (const [method, path] of [
    ['PATCH', '/account'],
    ['POST', '/account/addresses'],
    ['PUT', '/account/addresses/000000000000000000000000'],
    ['DELETE', '/account/addresses/000000000000000000000000'],
    ['POST', '/account/addresses/000000000000000000000000/default'],
    ['POST', '/account/password'],
  ]) {
    assert.equal((await t.call(method, path, {})).status, 401, `${method} ${path}`);
  }
});

test('changes the name, but never the email or role', async () => {
  const call = await register();
  const res = await call('PATCH', '/account', { name: '  Asha Rao Kumar ', email: 'x@example.com', role: 'admin' });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.name, 'Asha Rao Kumar');
  assert.equal(res.body.user.email, call.email);
  assert.equal(res.body.user.role, 'user');
  assert.equal((await call('GET', '/auth/me')).body.user.name, 'Asha Rao Kumar');
  assert.equal((await call('PATCH', '/account', { name: ' ' })).body.error, 'name: Enter your name');
});

test('changing the password needs the current one, refuses reusing it, and logs out other devices', async () => {
  const call = await register('old password');
  const other = t.browser();
  await other('POST', '/auth/login', { email: call.email, password: 'old password' });

  const wrong = await call('POST', '/account/password', { currentPassword: 'nope', newPassword: 'new password' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, 'Your current password is wrong');
  const same = await call('POST', '/account/password', {
    currentPassword: 'old password',
    newPassword: 'old password',
  });
  assert.equal(same.status, 400);
  assert.equal(same.body.error, 'Your new password must be different from your current one.');
  const short = await call('POST', '/account/password', { currentPassword: 'old password', newPassword: 'short' });
  assert.equal(short.status, 400);

  const ok = await call('POST', '/account/password', { currentPassword: 'old password', newPassword: 'new password' });
  assert.equal(ok.status, 204);
  assert.equal((await call('GET', '/auth/me')).body.user.email, call.email); // still logged in here
  assert.deepEqual((await other('GET', '/auth/me')).body, { user: null }); // logged out elsewhere
  assert.equal((await t.call('POST', '/auth/login', { email: call.email, password: 'old password' })).status, 401);
  assert.equal((await t.call('POST', '/auth/login', { email: call.email, password: 'new password' })).status, 200);
});

test('wrong current passwords count towards the login lock', async () => {
  const call = await register('right password');
  for (let i = 0; i < 4; i++) {
    const res = await call('POST', '/account/password', { currentPassword: `wrong ${i}`, newPassword: 'new password' });
    assert.equal(res.status, 400);
  }
  const fifth = await call('POST', '/account/password', { currentPassword: 'wrong 4', newPassword: 'new password' });
  assert.equal(fifth.status, 429);
  const right = await call('POST', '/account/password', {
    currentPassword: 'right password',
    newPassword: 'new password',
  });
  assert.equal(right.status, 429);
  assert.equal((await t.call('POST', '/auth/login', { email: call.email, password: 'right password' })).status, 429);
});
