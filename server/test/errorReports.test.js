import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_REPORTS, REPORTS_PER_HOUR } from '../src/routes/errorReports.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  customer = await register('customer@example.com', 'Asha Rao');
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}

const crash = (message, extra = {}) => ({
  kind: 'crash',
  message,
  stack: `TypeError: ${message}\n    at Product (https://bazaar.test/assets/index-abc.js:1:200)\n    at x (y.js:2:3)`,
  componentStack: '\n    at Product\n    at Layout',
  path: '/p/some-book',
  ...extra,
});
const report = (body) => t.call('POST', '/error-reports', body);
// The rate limit is per network, and every test request comes from localhost: start each test with a fresh count.
const resetLimit = () => t.db.collection('rateLimits').deleteMany({});
const list = async (status = 'open') => {
  const res = await admin('GET', `/admin/error-reports?status=${status}`);
  assert.equal(res.status, 200);
  return res.body;
};

test('reports of one problem are counted together, with the pages it happened on', async () => {
  await resetLimit();
  assert.equal((await report(crash('Cannot read properties of undefined'))).status, 204);
  assert.equal(
    (await report(crash('Cannot read properties of undefined', { path: '/p/other#token=secret' }))).status,
    204,
  );
  // The same message and top frame from a logged-in visitor, another line further down: still the same problem.
  const again = crash('Cannot read properties of undefined', { stack: undefined });
  again.stack =
    'TypeError: Cannot read properties of undefined\n    at Product (https://bazaar.test/assets/index-abc.js:1:200)';
  assert.equal((await customer('POST', '/error-reports', again)).status, 204);
  // A page that didn't load is another problem.
  const load = {
    kind: 'load',
    message: 'Failed to fetch dynamically imported module: https://bazaar.test/assets/AdminRoutes-abc.js',
    path: '/admin',
  };
  assert.equal((await report(load)).status, 204);

  const { items, total, counts } = await list();
  assert.equal(total, 2);
  assert.deepEqual(counts, { open: 2, fixed: 0 });
  const [newest, crashed] = items;
  assert.equal(newest.kind, 'load');
  assert.equal(newest.stack, null);
  assert.equal(crashed.count, 3);
  assert.equal(crashed.message, 'Cannot read properties of undefined');
  // What's after # never reaches the database.
  assert.deepEqual(crashed.paths, ['/p/some-book', '/p/other']);
  assert.match(crashed.stack, /at Product/);
  assert.equal(crashed.componentStack, '\n    at Product\n    at Layout');
  assert.ok(crashed.browser.length > 0);
  assert.ok(new Date(crashed.firstAt) <= new Date(crashed.lastAt));
  assert.equal(JSON.stringify(await t.db.collection('errorReports').find().toArray()).includes('secret'), false);
});

test('reports are checked, and long text is shortened rather than refused', async () => {
  await resetLimit();
  for (const body of [
    {},
    { ...crash('x'), kind: 'warning' },
    { ...crash('   ') },
    { ...crash('x'), path: 'https://elsewhere.example/p' },
    { ...crash('x'), message: 'a'.repeat(20_001) },
  ]) {
    assert.equal((await report(body)).status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal((await report(crash('$where is not a field', { stack: 'b'.repeat(9000) }))).status, 204);
  const doc = await t.db.collection('errorReports').findOne({ message: '$where is not a field' });
  assert.equal(doc.stack.length, 4000);
});

test('only admins see the list or mark problems fixed, and fixing is logged once', async () => {
  await resetLimit();
  assert.equal((await t.call('GET', '/admin/error-reports')).status, 401);
  assert.equal((await customer('GET', '/admin/error-reports')).status, 403);
  assert.equal((await admin('GET', '/admin/error-reports?status=all')).status, 400);
  const [item] = (await list()).items.filter((i) => i.message === 'Cannot read properties of undefined');
  assert.equal((await customer('POST', `/admin/error-reports/${item.id}/fixed`, { fixed: true })).status, 403);
  assert.equal((await admin('POST', `/admin/error-reports/${item.id}/fixed`, {})).status, 400);
  assert.equal(
    (await admin('POST', '/admin/error-reports/000000000000000000000000/fixed', { fixed: true })).status,
    404,
  );

  const res = await admin('POST', `/admin/error-reports/${item.id}/fixed`, { fixed: true });
  assert.equal(res.status, 200);
  assert.ok(res.body.fixedAt);
  assert.equal((await admin('POST', `/admin/error-reports/${item.id}/fixed`, { fixed: true })).status, 200);
  const logged = (await admin('GET', '/admin/activity?area=errors')).body.items;
  assert.equal(logged.length, 1);
  assert.equal(logged[0].action, 'Marked error fixed');
  assert.equal(logged[0].target.label, '“Cannot read properties of undefined”');
  assert.deepEqual(
    (await list('fixed')).items.map((i) => i.id),
    [item.id],
  );
  assert.equal((await admin('GET', '/admin/dashboard')).body.openErrors, (await list()).total);

  // It happens again: open again, still counted on the same entry.
  await report(crash('Cannot read properties of undefined'));
  const reopened = (await list()).items.find((i) => i.id === item.id);
  assert.equal(reopened.fixedAt, null);
  assert.equal(reopened.count, 4);
});

test('one network can send only so many reports an hour', async () => {
  await resetLimit();
  for (let i = 0; i < REPORTS_PER_HOUR; i++) {
    assert.equal((await report(crash(`Problem ${i}`))).status, 204);
  }
  assert.equal((await report(crash('One too many'))).status, 429);
  assert.equal(await t.db.collection('errorReports').countDocuments({ message: 'One too many' }), 0);
});

test('once the list is full, new problems are dropped but known ones still count', async () => {
  await resetLimit();
  const reports = t.db.collection('errorReports');
  const known = await reports.findOne({ message: 'Problem 0' });
  const filler = Array.from({ length: MAX_REPORTS - (await reports.countDocuments()) }, (_, i) => ({
    key: `filler-${i}`,
    kind: 'crash',
    message: `Filler ${i}`,
    count: 1,
    firstAt: new Date(),
    lastAt: new Date(),
    paths: ['/'],
    browser: '',
    fixedAt: null,
  }));
  await reports.insertMany(filler);
  assert.equal((await report(crash('Brand new problem'))).status, 204);
  assert.equal(await reports.countDocuments({ message: 'Brand new problem' }), 0);
  assert.equal((await report(crash('Problem 0'))).status, 204);
  assert.equal((await reports.findOne({ _id: known._id })).count, 2);
  await reports.deleteMany({ key: /^filler-/ });
});
