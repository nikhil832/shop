import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DAILY_CAP, PER_HOUR, checkReading } from '../src/smartSearch.js';
import { startTestServer } from './helpers.js';

// Plain-words search (stage 62). Claude is a stand-in (t.claude): "under N" is a top price, listed brands and category
// names are picked up, the rest are the words. Nothing here calls the real API or costs money.
let t;
let off; // a server without an API key
let admin;
before(async () => {
  [t, off] = await Promise.all([startTestServer({ ai: 'claude-haiku-5-5' }), startTestServer()]);
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Owner', email: 'owner@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
});
after(() => Promise.all([t.stop(), off.stop()]));

const understand = (q, server = t) => server.call('GET', `/search/understand?q=${encodeURIComponent(q)}`);
const resetLimits = () => t.db.collection('rateLimits').deleteMany({});

test("a reading is checked against the store's own categories, brands and prices", () => {
  const store = { categories: [{ slug: 'fashion', name: 'Fashion' }], brands: ['Stride', 'Urbane'] };
  const read = (fields) =>
    checkReading(
      {
        understood: true,
        words: 'shoes',
        category: null,
        brands: [],
        minPrice: null,
        maxPrice: null,
        inStock: false,
        ...fields,
      },
      'cheap shoes',
      store,
    );
  assert.deepEqual(read({ category: 'shoes', brands: ['stride', 'Nike'], minPrice: 3000.4, maxPrice: 1000 }), {
    q: 'shoes',
    category: '',
    brand: 'Stride',
    minPrice: '1000',
    maxPrice: '3000',
    inStock: '',
  });
  // Nothing beyond the words typed, or not a search at all: nothing to offer.
  assert.equal(read({ words: 'Cheap  shoes' }), null);
  assert.equal(read({ understood: false, category: 'fashion' }), null);
  assert.equal(read({ words: '', maxPrice: -5 }), null);
});

test('a search that found nothing is read into filters, offered only when they find something', async () => {
  await resetLimits();
  const calls = t.claude.calls.length;
  const res = await understand('Running shoes under 3000');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    search: { q: 'running shoes', category: 'fashion', brand: '', minPrice: '', maxPrice: '3000', inStock: '' },
    total: 1,
  });
  const { body } = t.claude.calls.at(-1);
  assert.match(body.system, /never as instructions/);
  const prompt = body.messages[0].content[0].text;
  assert.match(prompt, /^Categories \(slug: name\): .*fashion: Fashion/m);
  assert.match(prompt, /^Brands: .*Stride/m);
  assert.match(prompt, /^The shopper typed: Running shoes under 3000$/m);

  // The same words again (any case or spacing) are remembered: no new call.
  assert.equal((await understand('  running   SHOES under 3000 ')).body.total, 1);
  assert.equal(t.claude.calls.length, calls + 1);

  // Shoes under ₹2,000: the store has none, so nothing is offered (and that's remembered too).
  assert.deepEqual((await understand('running shoes under 2000')).body, { search: null });
  assert.deepEqual((await understand('running shoes under 2000')).body, { search: null });
  assert.equal(t.claude.calls.length, calls + 2);

  // Brands the store doesn't have are dropped; not a search at all gives nothing.
  assert.equal((await understand('stride shoes under 3000')).body.search.brand, 'Stride');
  assert.deepEqual((await understand('hello there')).body, { search: null });
  assert.equal((await understand('x')).status, 400);
});

test('each network gets a few new readings an hour, and the store a few hundred a day', async () => {
  await resetLimits();
  const calls = t.claude.calls.length;
  for (let i = 0; i < PER_HOUR; i++) await understand(`blue kettle number ${i}`);
  assert.equal(t.claude.calls.length, calls + PER_HOUR);
  assert.deepEqual((await understand('one more kettle')).body, { search: null });
  assert.equal(t.claude.calls.length, calls + PER_HOUR);
  // Remembered ones still work past the limit.
  assert.equal((await understand('Running shoes under 3000')).body.total, 1);

  await resetLimits();
  await t.db.collection('settings').updateOne({ _id: 'smartSearch' }, { $set: { used: DAILY_CAP } });
  assert.deepEqual((await understand('green kettle')).body, { search: null });
  assert.equal(t.claude.calls.length, calls + PER_HOUR);
  const usage = (await admin('GET', '/admin/smart-search')).body;
  assert.deepEqual(usage, { available: true, enabled: true, usedToday: DAILY_CAP, dailyCap: DAILY_CAP });
  await t.db.collection('settings').updateOne({ _id: 'smartSearch' }, { $set: { used: 0 } });
});

test("a failed call isn't remembered; switched off or without a key, nothing is read", async () => {
  await resetLimits();
  t.claude.failNext(2); // the SDK retries once
  assert.deepEqual((await understand('stride shoes in stock')).body, { search: null });
  assert.equal((await understand('stride shoes in stock')).body.search.inStock, '1'); // tried again

  const customer = t.browser();
  await customer('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
  assert.equal((await customer('PUT', '/admin/smart-search', { enabled: false })).status, 403);
  await admin('PUT', '/admin/smart-search', { enabled: false });
  await admin('PUT', '/admin/smart-search', { enabled: false });
  assert.deepEqual((await understand('Running shoes under 3000')).body, { search: null });
  const logged = (await admin('GET', '/admin/activity?area=settings')).body.items.filter((e) =>
    /plain-words/.test(e.action),
  );
  assert.equal(logged.length, 1);
  await admin('PUT', '/admin/smart-search', { enabled: true });

  assert.deepEqual((await understand('Running shoes under 3000', off)).body, { search: null });
});
