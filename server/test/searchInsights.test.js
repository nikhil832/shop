import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TERMS, recordSearch, weekOf } from '../src/searchInsights.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  customer = await register('customer@example.com');
});
after(() => t.stop());
beforeEach(() => t.db.collection('searchStats').deleteMany({}));

async function register(email) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name: 'Someone', email, password: 'password123' })).status, 201);
  return call;
}

const search = (query) => t.call('GET', `/products?${query}`);
const insights = async (query = '') => {
  const res = await admin('GET', `/admin/search-insights${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

test('weeks start on Monday, India time', () => {
  assert.equal(weekOf(new Date('2026-10-25T23:30:00+05:30')), '2026-10-19'); // Sunday night
  assert.equal(weekOf(new Date('2026-10-26T00:10:00+05:30')), '2026-10-26'); // Monday just after midnight
  assert.equal(weekOf(new Date('2026-10-28T12:00:00+05:30')), '2026-10-26');
});

test('plain searches are counted by their words; paging, sorting and filters are not new searches', async () => {
  await search('q=phone');
  await search('q=%20%20PHONE%20');
  await search('q=phone&page=2');
  await search('q=phone&sort=price_asc');
  await search('q=phone&inStock=1');
  await search('q=phone&brand=Voltix');
  await search('q=unicorn%20saddle');
  await search('category=books'); // no words: not a search
  const body = await insights();
  assert.deepEqual(body.totals, { searches: 3, different: 2, nothingFound: 1 });
  const phone = body.top.find((s) => s.term === 'phone');
  assert.equal(phone.count, 2);
  assert.ok(phone.found > 0);
  assert.deepEqual(body.nothingFound, [{ term: 'unicorn saddle', count: 1, found: 0 }]);
  assert.equal(body.week, weekOf(new Date()));
  assert.equal(body.weeks[0], body.week);
});

test('nothing about the searcher is kept', async () => {
  await customer('GET', '/products?q=headphones');
  const [doc] = await t.db.collection('searchStats').find().toArray();
  assert.deepEqual(Object.keys(doc).sort(), ['_id', 'count', 'found', 'lastAt', 'term', 'week']);
});

test('a week holds at most MAX_TERMS different searches; ones already there still count', async () => {
  const week = weekOf(new Date());
  await t.db.collection('searchStats').insertMany(
    Array.from({ length: MAX_TERMS }, (_, i) => ({
      week,
      term: `filler ${i}`,
      count: 1,
      found: 0,
      lastAt: new Date(),
    })),
  );
  await recordSearch(t.db, 'brand new words', 3);
  await recordSearch(t.db, 'filler 7', 0);
  assert.equal(await t.db.collection('searchStats').countDocuments({ term: 'brand new words' }), 0);
  assert.equal((await t.db.collection('searchStats').findOne({ term: 'filler 7' })).count, 2);
});

test('other weeks can be looked at; admins only', async () => {
  const lastWeek = new Date(Date.now() - 7 * 86_400_000);
  await recordSearch(t.db, 'diwali lights', 0, lastWeek);
  const body = await insights(`?week=${weekOf(lastWeek)}`);
  assert.deepEqual(
    body.top.map((s) => s.term),
    ['diwali lights'],
  );
  assert.ok(body.weeks.includes(weekOf(lastWeek)));
  assert.equal((await admin('GET', '/admin/search-insights?week=last')).status, 400);
  assert.equal((await customer('GET', '/admin/search-insights')).status, 403);
  assert.equal((await t.call('GET', '/admin/search-insights')).status, 401);
});
