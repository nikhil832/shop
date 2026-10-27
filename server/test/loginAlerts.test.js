import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newLoginEmail } from '../src/emails.js';
import { DEVICE_COOKIE, describeBrowser } from '../src/loginAlerts.js';
import { codeAt, stepOf } from '../src/totp.js';
import { startTestServer } from './helpers.js';

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

let t;
before(async () => {
  t = await startTestServer();
  for (const [email, name] of [
    ['owner@example.com', 'Store Owner'],
    ['customer@example.com', 'Asha Rao'],
    ['second@example.com', 'Second Admin'],
  ]) {
    assert.equal((await t.browser()('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  }
  await t.db
    .collection('users')
    .updateMany({ email: { $in: ['owner@example.com', 'second@example.com'] } }, { $set: { role: 'admin' } });
});
after(() => t.stop());

const alerts = (email) => t.mail.sent.filter((m) => m.to.email === email && m.subject.startsWith('New login'));
async function logIn(call, email = 'owner@example.com') {
  const res = await call('POST', '/auth/login', { email, password: 'password123' });
  assert.equal(res.status, 200);
  return res;
}
const logOut = async (call) => assert.equal((await call('POST', '/auth/logout')).status, 204);

test('names browsers the way people know them', () => {
  assert.equal(describeBrowser(CHROME_WINDOWS), 'Chrome on Windows');
  assert.equal(describeBrowser(SAFARI_IPHONE), 'Safari on iPhone');
  assert.equal(
    describeBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0'),
    'Firefox on Mac',
  );
  assert.equal(
    describeBrowser(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
    ),
    'Edge on Windows',
  );
  assert.equal(describeBrowser('curl/8.7.1'), 'An unknown browser');
  assert.equal(describeBrowser(undefined), 'An unknown browser');
});

test("an admin's first login from a browser emails them and is logged; the same browser later is quiet", async () => {
  const before = t.mail.sent.length;
  const laptop = t.browser({ 'User-Agent': CHROME_WINDOWS });
  const res = await logIn(laptop);
  assert.match(res.headers.getSetCookie().join('\n'), new RegExp(`${DEVICE_COOKIE}=[\\w-]{43}; Max-Age=34560000;`));
  assert.ok(laptop.cookies.has(DEVICE_COOKIE));
  const [alert, ...more] = alerts('owner@example.com');
  assert.equal(more.length, 0);
  assert.equal(t.mail.sent.length, before + 1);
  assert.equal(alert.subject, 'New login to your Bazaar admin account');
  assert.match(alert.text, /Browser: Chrome on Windows/);
  assert.match(alert.text, /IP address: (::1|127\.0\.0\.1)\n/);
  assert.match(alert.text, /\(India time\)/);
  assert.match(alert.text, /https:\/\/bazaar\.test\/account/);

  const entry = (await laptop('GET', '/admin/activity?area=accounts')).body.items[0];
  assert.equal(entry.action, 'Logged in from a new browser');
  assert.equal(entry.by.name, 'Store Owner');
  assert.deepEqual(entry.target, { label: 'owner@example.com', path: null });
  assert.deepEqual(entry.changes, [
    { field: 'Browser', to: 'Chrome on Windows' },
    { field: 'IP address', to: entry.changes[1].to },
  ]);

  // Logging out keeps the browser cookie: logging in again from it sends nothing.
  await logOut(laptop);
  assert.ok(laptop.cookies.has(DEVICE_COOKIE));
  await logIn(laptop);
  assert.equal(alerts('owner@example.com').length, 1);
  const device = await t.db.collection('knownDevices').findOne({});
  assert.equal(device.browser, 'Chrome on Windows');
  assert.ok(device.lastAt > device.firstAt);
  assert.equal(JSON.stringify(device).includes(laptop.cookies.get(DEVICE_COOKIE)), false); // only a hash is kept

  // Another browser alerts again.
  await logIn(t.browser({ 'User-Agent': SAFARI_IPHONE }));
  assert.equal(alerts('owner@example.com').length, 2);
  assert.match(alerts('owner@example.com')[1].text, /Safari on iPhone/);
});

test('a browser is new for each account: another admin on the same laptop is told too', async () => {
  const laptop = t.browser({ 'User-Agent': CHROME_WINDOWS });
  await logIn(laptop);
  const cookie = laptop.cookies.get(DEVICE_COOKIE);
  await logOut(laptop);
  await logIn(laptop, 'second@example.com');
  assert.equal(laptop.cookies.get(DEVICE_COOKIE), cookie); // the browser keeps one cookie
  assert.equal(alerts('second@example.com').length, 1);
});

test('customers get no browser cookie and no alerts', async () => {
  const before = t.mail.sent.length;
  const shopper = t.browser();
  const res = await logIn(shopper, 'customer@example.com');
  assert.equal(res.headers.getSetCookie().length, 1); // only the session
  assert.equal(shopper.cookies.has(DEVICE_COOKIE), false);
  assert.equal(t.mail.sent.length, before);
  assert.equal(await t.db.collection('knownDevices').countDocuments({ browser: { $exists: true }, userId: null }), 0);
});

test("a cookie that isn't one of ours is replaced, and a mail failure doesn't stop the login", async () => {
  const call = t.browser({ Cookie: `${DEVICE_COOKIE}=not-a-real-one` });
  t.mail.failNext();
  const res = await logIn(call);
  assert.ok(res.body.user);
  assert.match(res.headers.getSetCookie().join('\n'), new RegExp(`${DEVICE_COOKIE}=[\\w-]{43};`));
});

test('with two-step login, the alert comes after the code, not the password', async () => {
  const call = t.browser({ 'User-Agent': SAFARI_IPHONE });
  await logIn(call, 'second@example.com');
  const setup = await call('POST', '/account/two-step/setup', { password: 'password123' });
  assert.equal(setup.status, 200);
  const code = () => codeAt(setup.body.secret, stepOf());
  assert.equal((await call('POST', '/account/two-step/enable', { code: code() })).status, 200);
  await logOut(call);

  const sent = alerts('second@example.com').length;
  const fresh = t.browser({ 'User-Agent': CHROME_WINDOWS });
  const first = await logIn(fresh, 'second@example.com');
  assert.equal(first.body.twoStep, true);
  assert.equal(alerts('second@example.com').length, sent);
  assert.equal(fresh.cookies.has(DEVICE_COOKIE), false);
  // The code is the next step's, as the app's current one was used to switch two-step on.
  const res = await fresh('POST', '/auth/login/code', {
    ticket: first.body.ticket,
    code: codeAt(setup.body.secret, stepOf() + 1),
  });
  assert.equal(res.status, 200);
  assert.equal(alerts('second@example.com').length, sent + 1);
});

test('the email escapes what it shows', () => {
  const email = newLoginEmail(
    { name: 'Ravi <b>', email: 'ravi@example.com' },
    { at: new Date('2026-10-27T05:00:00Z'), browser: 'Chrome on <Windows>', ip: '10.0.0.1' },
    'https://bazaar.test',
  );
  assert.match(email.text, /27 Oct 2026, 10:30 am \(India time\)/);
  assert.doesNotMatch(email.html, /<Windows>|<b>,/);
  assert.match(email.html, /Chrome on &lt;Windows&gt;/);
});
