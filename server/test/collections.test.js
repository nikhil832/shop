import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { previewRouter } from '../src/preview.js';
import { startTestServer } from './helpers.js';

const HTML =
  '<!doctype html><html><head><meta charset="UTF-8" /><title>Bazaar</title></head><body><div id="root"></div></body></html>';

let t;
let admin;
let server;
let base;
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  const app = express();
  app.set('trust proxy', 1);
  app.use(previewRouter(t.ctx, HTML));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  server.close();
  await t.stop();
});

const idOf = async (slug) => (await t.db.collection('products').findOne({ slug }))._id.toString();
const BOOK = 'the-quiet-engineer-paperback';
const SHOES = 'stride-running-shoes';
const HOUR = 3_600_000;
const make = (body) => admin('POST', '/admin/collections', body);

test('admins make a collection from chosen products in their order; its page shows the shown ones', async () => {
  const ids = [await idOf(SHOES), await idOf(BOOK)];
  // Validation and permissions.
  for (const body of [
    { name: 'x', productIds: ids },
    { name: 'Gifts', productIds: [] },
    { name: 'Gifts', productIds: [ids[0], ids[0]] },
    { name: 'Gifts', productIds: ids, startsAt: '2026-11-02T00:00:00Z', endsAt: '2026-11-01T00:00:00Z' },
  ]) {
    assert.equal((await make(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await make({ name: 'Gifts', productIds: ['0'.repeat(24)] })).status, 400);
  assert.equal((await t.call('POST', '/admin/collections', { name: 'Gifts', productIds: ids })).status, 401);
  const customer = t.browser();
  await customer('POST', '/auth/register', { name: 'Asha', email: 'asha@example.com', password: 'password123' });
  assert.equal((await customer('GET', '/admin/collections')).status, 403);

  const res = await make({ name: 'Diwali Gifts!', description: 'Ideas for everyone.', productIds: ids, onHome: true });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.slug, 'diwali-gifts');
  assert.equal(res.body.status, 'live');
  // Same name again: a numbered slug.
  assert.equal((await make({ name: 'Diwali gifts', productIds: ids })).body.slug, 'diwali-gifts-2');

  const page = await t.call('GET', '/collections/diwali-gifts');
  assert.equal(page.status, 200);
  assert.equal(page.body.name, 'Diwali Gifts!');
  assert.equal(page.body.description, 'Ideas for everyone.');
  assert.deepEqual(
    page.body.items.map((p) => p.slug),
    [SHOES, BOOK],
  );
  // A hidden product drops out of the page (not the list).
  await t.db.collection('products').updateOne({ slug: BOOK }, { $set: { active: false } });
  assert.deepEqual(
    (await t.call('GET', '/collections/diwali-gifts')).body.items.map((p) => p.slug),
    [SHOES],
  );
  await t.db.collection('products').updateOne({ slug: BOOK }, { $set: { active: true } });
  assert.equal((await t.call('GET', '/collections/no-such-thing')).status, 404);
  assert.ok(await t.db.collection('activity').findOne({ area: 'collections', action: 'Added collection' }));
});

test('dates and the switch decide when it shows; admins can look at it before', async () => {
  const ids = [await idOf(BOOK)];
  const now = Date.now();
  const soon = (await make({ name: 'Weekend deals', productIds: ids, startsAt: new Date(now + HOUR) })).body;
  assert.equal(soon.status, 'upcoming');
  assert.equal((await t.call('GET', `/collections/${soon.slug}`)).status, 404);
  const preview = await admin('GET', `/collections/${soon.slug}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.live, false);

  const over = await make({
    name: 'Last week',
    productIds: ids,
    startsAt: new Date(now - 2 * HOUR),
    endsAt: new Date(now - HOUR),
  });
  assert.equal(over.body.status, 'ended');
  assert.equal((await t.call('GET', `/collections/${over.body.slug}`)).status, 404);

  // Switched off with a PUT of the whole form; the slug stays even when renamed.
  const off = await admin('PUT', `/admin/collections/${soon.id}`, {
    name: 'Weekend specials',
    productIds: ids,
    active: false,
  });
  assert.equal(off.status, 200);
  assert.equal(off.body.slug, 'weekend-deals');
  assert.equal(off.body.status, 'off');
  const changed = await t.db.collection('activity').findOne({ action: 'Changed collection' });
  assert.deepEqual(
    changed.changes.map((c) => c.field),
    ['Name', 'Starts', 'Shown'],
  );
});

test('the home page gets live collections marked for it, in the admins’ order, with their first cards', async () => {
  await t.db.collection('collections').deleteMany({});
  const all = (await t.call('GET', '/products?pageSize=24')).body.items.map((p) => p.id);
  const a = (await make({ name: 'Row A', productIds: all.slice(0, 12), onHome: true })).body;
  const b = (await make({ name: 'Row B', productIds: all.slice(12, 14), onHome: true })).body;
  await make({ name: 'Not on home', productIds: all.slice(0, 2) });
  await make({ name: 'Later', productIds: all.slice(0, 2), onHome: true, startsAt: new Date(Date.now() + HOUR) });

  let home = (await t.call('GET', '/collections/home')).body.items;
  assert.deepEqual(
    home.map((c) => c.name),
    ['Row A', 'Row B'],
  );
  assert.equal(home[0].items.length, 8);
  assert.equal(home[1].items.length, 2);

  assert.equal((await admin('POST', `/admin/collections/${b.id}/move`, { direction: 'up' })).status, 204);
  home = (await t.call('GET', '/collections/home')).body.items;
  assert.deepEqual(
    home.map((c) => c.name),
    ['Row B', 'Row A'],
  );
  // Moving the first one up does nothing.
  await admin('POST', `/admin/collections/${b.id}/move`, { direction: 'up' });
  assert.equal((await admin('GET', '/admin/collections')).body.items[0].name, 'Row B');

  assert.equal((await admin('DELETE', `/admin/collections/${a.id}`)).status, 204);
  assert.equal((await admin('DELETE', `/admin/collections/${a.id}`)).status, 404);
  assert.deepEqual(
    (await t.call('GET', '/collections/home')).body.items.map((c) => c.name),
    ['Row B'],
  );
});

test('a live collection has its own link preview and is in the sitemap; others are not found', async () => {
  await t.db.collection('collections').deleteMany({});
  const ids = [await idOf(BOOK)];
  await make({ name: 'Books we love', description: 'Hand-picked reads.', productIds: ids });
  await make({ name: 'Hidden list', productIds: ids, active: false });

  const res = await fetch(`${base}/c/books-we-love`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>Books we love · Bazaar<\/title>/);
  assert.match(html, /<meta property="og:description" content="Hand-picked reads." \/>/);
  assert.match(html, /<meta property="og:image" content="http:\/\/localhost:\d+\/og-image.png" \/>/);
  assert.equal((await fetch(`${base}/c/hidden-list`)).status, 404);

  const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
  assert.match(sitemap, /\/c\/books-we-love<\/loc>/);
  assert.doesNotMatch(sitemap, /hidden-list/);
});
