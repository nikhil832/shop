import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { startTestServer } from './helpers.js';
import { MAX_SAVED, sendSavedSearchAlerts } from '../src/savedSearches.js';

// Saved searches (stage 144).
let t;
let asha;
before(async () => {
  t = await startTestServer();
  asha = t.browser();
  await asha('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
});
after(() => t.stop());
beforeEach(() => {
  t.mail.sent.length = 0;
});

const HOUR = 3_600_000;
const products = () => t.db.collection('products');
// A new product like an existing one (a copy with its own id, slug and title), added `at`.
async function addLike(slug, changes = {}, at = new Date()) {
  const { _id, ...source } = await products().findOne({ slug });
  const doc = { ...source, _id: new ObjectId(), createdAt: at, ...changes };
  await products().insertOne(doc);
  return doc;
}

test('a customer saves a search; it is checked, named and kept once', async () => {
  assert.equal((await t.call('POST', '/saved-searches', { search: '?q=voltix' })).status, 401);
  assert.equal((await asha('POST', '/saved-searches', { search: '?page=2&sort=newest' })).status, 400);
  assert.equal((await asha('POST', '/saved-searches', { search: '?q=voltix&rating=9' })).status, 400);

  const res = await asha('POST', '/saved-searches', {
    search: '?q=voltix&category=mobiles&minPrice=10000&sort=price_asc&page=2',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.label, '“voltix” in Mobiles · from ₹10,000');
  assert.equal(res.body.path, '/search?q=voltix&category=mobiles&minPrice=10000');
  // The same search in another order or case is the same saved search.
  const again = await asha('POST', '/saved-searches', { search: 'minPrice=10000&category=mobiles&q=Voltix' });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, res.body.id);

  const spec = await asha('POST', '/saved-searches', {
    search: 'category=laptops&spec=RAM%3A16%20GB&brand=Arcbook&maxPrice=90000&inStock=1',
  });
  assert.equal(spec.body.label, 'Laptops · Arcbook · under ₹90,000 · RAM 16 GB · in stock');
  const list = (await asha('GET', '/saved-searches')).body;
  assert.equal(list.items.length, 2);
  assert.equal(list.max, MAX_SAVED);
  assert.equal((await asha('GET', '/account/data')).body.savedSearches.length, 2);
});

test('the hourly check emails new matching products once, with old, hidden and other products left out', async () => {
  const start = new Date();
  // Seed products are older than the search: nothing yet.
  assert.equal(await sendSavedSearchAlerts(t.ctx, start), 0);

  const later = new Date(start.getTime() + 60_000);
  const match = await addLike(
    'voltix-nova-5g-8gb-ram-128gb',
    { slug: 'voltix-nova-6', title: 'Voltix Nova 6 5G' },
    later,
  );
  await addLike('voltix-nova-5g-8gb-ram-128gb', { slug: 'voltix-cheap', title: 'Voltix Lite', price: 900000 }, later);
  await addLike('the-quiet-engineer-paperback', { slug: 'voltix-book', title: 'Voltix: a history' }, later);
  const hidden = await addLike(
    'voltix-nova-5g-8gb-ram-128gb',
    { slug: 'voltix-nova-7', title: 'Voltix Nova 7 5G', active: false },
    later,
  );

  // Checked within the hour: waits.
  assert.equal(await sendSavedSearchAlerts(t.ctx, new Date(start.getTime() + 30 * 60_000)), 0);
  const hourOn = new Date(start.getTime() + HOUR + 1000);
  assert.equal(await sendSavedSearchAlerts(t.ctx, hourOn), 1);
  const [mail] = t.mail.sent;
  assert.equal(mail.to.email, 'asha@example.com');
  assert.equal(mail.subject, 'New for your search: “voltix” in Mobiles · from ₹10,000');
  assert.match(mail.text, /- Voltix Nova 6 5G: ₹18,999\n {2}https:\/\/bazaar\.test\/p\/voltix-nova-6/);
  assert.doesNotMatch(mail.text, /Voltix Lite|a history|Nova 7/); // too cheap, another category, hidden
  assert.equal(match.slug, 'voltix-nova-6');

  // Told once; a product shown later is new news.
  await products().updateOne({ _id: hidden._id }, { $set: { active: true } });
  t.mail.sent.length = 0;
  assert.equal(await sendSavedSearchAlerts(t.ctx, new Date(hourOn.getTime() + HOUR + 1000)), 1);
  assert.match(t.mail.sent[0].text, /Voltix Nova 7 5G/);
  assert.doesNotMatch(t.mail.sent[0].text, /Nova 6/);
});

test('a failed email is tried at the next check; removing a search stops it; at most 10', async () => {
  const at = new Date(Date.now() + 10 * HOUR);
  await addLike('arcbook-air-14-16gb-512gb-ssd', { slug: 'arcbook-air-15', title: 'Arcbook Air 15' }, new Date());
  t.mail.failNext();
  assert.equal(await sendSavedSearchAlerts(t.ctx, at), 0);
  assert.equal(await sendSavedSearchAlerts(t.ctx, new Date(at.getTime() + HOUR + 1000)), 1);
  assert.match(t.mail.sent[0].text, /Arcbook Air 15/);

  const { items } = (await asha('GET', '/saved-searches')).body;
  for (const s of items) assert.equal((await asha('DELETE', `/saved-searches/${s.id}`)).status, 204);
  assert.equal((await asha('GET', '/saved-searches')).body.items.length, 0);
  for (let i = 0; i < MAX_SAVED; i++) {
    assert.equal((await asha('POST', '/saved-searches', { search: `q=phone${i}` })).status, 201);
  }
  const full = await asha('POST', '/saved-searches', { search: 'q=one-more' });
  assert.equal(full.status, 409);
  assert.match(full.body.error, /up to 10 searches/);
});
