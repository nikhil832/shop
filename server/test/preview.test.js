import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { previewRouter, withPreview } from '../src/preview.js';
import { startTestServer } from './helpers.js';

// A stand-in for the built index.html: the real one has the same <title> and </head>.
const HTML =
  '<!doctype html><html><head><meta charset="UTF-8" /><title>Bazaar</title></head><body><div id="root"></div></body></html>';

let t;
let server;
let base;
before(async () => {
  t = await startTestServer();
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

// The content of every <meta> tag on the page, by its property or name.
async function page(path, headers = {}) {
  const res = await fetch(base + path, { headers });
  const html = await res.text();
  const meta = Object.fromEntries(
    [...html.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)" \/>/g)].map((m) => [m[1], m[2]]),
  );
  return { status: res.status, html, meta, title: html.match(/<title>([^<]*)<\/title>/)?.[1] };
}

test('a product page carries its name, price, brand and highlights for link previews', async () => {
  const p = await page('/p/the-quiet-engineer-paperback');
  assert.equal(p.status, 200);
  assert.equal(p.title, 'The Quiet Engineer (Paperback) · ₹349');
  assert.equal(p.meta['og:title'], 'The Quiet Engineer (Paperback) · ₹349');
  assert.equal(p.meta['og:type'], 'product');
  assert.equal(p.meta['og:site_name'], 'Bazaar');
  assert.match(p.meta['og:description'], /^Pustak Press · /);
  assert.equal(p.meta['og:url'], `${base}/p/the-quiet-engineer-paperback`);
  // The sample pictures are SVG, which previews can't show: the store's image stands in.
  assert.equal(p.meta['og:image'], `${base}/og-image.png`);
  assert.equal(p.meta['twitter:card'], 'summary_large_image');
  assert.equal(p.meta.description, p.meta['og:description']);
  // The app still loads as before.
  assert.ok(p.html.includes('<div id="root"></div>'));
});

test('an uploaded photo is the preview image; variants at different prices say "from"; sold out says so', async () => {
  const photo = `/api/images/${'a'.repeat(24)}`;
  await t.db.collection('products').updateOne({ slug: 'urbane-women-kurta-set' }, { $push: { images: photo } });
  const kurta = await page('/p/urbane-women-kurta-set');
  assert.equal(kurta.meta['og:title'], 'Urbane Women Kurta Set · from ₹1,499');
  assert.equal(kurta.meta['og:image'], `${base}${photo}`);

  const soldOut = await page('/p/ferro-chromebook-11');
  assert.match(soldOut.meta['og:description'], /· Out of stock/);
});

test('behind the HTTPS proxy, links are https; other pages get the store preview; hidden products are not found', async () => {
  // Render's proxy says the visitor used HTTPS; the host is the one the visitor asked for (here, localhost).
  const p = await page('/p/the-quiet-engineer-paperback', { 'X-Forwarded-Proto': 'https' });
  const https = base.replace('http://', 'https://');
  assert.equal(p.meta['og:url'], `${https}/p/the-quiet-engineer-paperback`);
  assert.equal(p.meta['og:image'], `${https}/og-image.png`);

  const home = await page('/');
  assert.equal(home.status, 200);
  assert.equal(home.title, 'Bazaar');
  assert.equal(home.meta['og:title'], 'Bazaar');
  assert.match(home.meta['og:description'], /demo store/);
  assert.equal((await page('/search?q=phone')).meta['og:url'], `${base}/search`);

  await t.db.collection('products').updateOne({ slug: 'bolt-bass-neckband' }, { $set: { active: false } });
  const hidden = await page('/p/bolt-bass-neckband');
  assert.equal(hidden.status, 404);
  assert.equal(hidden.title, 'Product not found · Bazaar');
  assert.ok(!hidden.html.includes('Bolt Bass'));
  assert.equal((await page('/p/no-such-thing')).status, 404);
});

test("what a product's admin typed is escaped in the page", () => {
  const html = withPreview(HTML, {
    title: 'Mug "Best" <script>alert(1)</script> & co',
    description: "It's <b>great</b>",
    image: 'https://x/og-image.png',
    url: 'https://x/p/mug',
  });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('<title>Mug &quot;Best&quot; &lt;script&gt;alert(1)&lt;/script&gt; &amp; co</title>'));
  assert.ok(html.includes('content="It&#39;s &lt;b&gt;great&lt;/b&gt;"'));
});
