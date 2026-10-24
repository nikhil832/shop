import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { previewRouter, withPreview, withSiteVerification } from '../src/preview.js';
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

// The schema.org data in a page's <script type="application/ld+json">.
const jsonLd = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);

test('a product page tells search engines its price, stock, rating and canonical address', async () => {
  const p = await page('/p/the-quiet-engineer-paperback');
  assert.ok(p.html.includes(`<link rel="canonical" href="${base}/p/the-quiet-engineer-paperback" />`));
  const data = jsonLd(p.html);
  assert.equal(data['@type'], 'Product');
  assert.equal(data.name, 'The Quiet Engineer (Paperback)');
  assert.deepEqual(data.brand, { '@type': 'Brand', name: 'Pustak Press' });
  assert.equal(data.image, undefined); // only SVG placeholders, which Google can't use
  assert.deepEqual(data.offers, {
    '@type': 'Offer',
    price: '349.00',
    priceCurrency: 'INR',
    availability: 'https://schema.org/InStock',
    url: `${base}/p/the-quiet-engineer-paperback`,
  });
  assert.equal(data.aggregateRating['@type'], 'AggregateRating');
  assert.ok(data.aggregateRating.ratingCount > 0);

  // Variants at different prices are a price range; sold out says so; other pages carry none of this.
  const kurta = jsonLd((await page('/p/urbane-women-kurta-set')).html);
  assert.equal(kurta.offers['@type'], 'AggregateOffer');
  assert.equal(kurta.offers.lowPrice, '1499.00');
  assert.ok(Number(kurta.offers.highPrice) > 1499);
  assert.equal(
    jsonLd((await page('/p/ferro-chromebook-11')).html).offers.availability,
    'https://schema.org/OutOfStock',
  );
  const home = await page('/');
  assert.ok(!home.html.includes('application/ld+json'));
  assert.ok(!home.html.includes('rel="canonical"'));
});

test('a title with "</script>" in it cannot end the structured data early', () => {
  const html = withPreview(HTML, {
    title: 'Mug',
    description: 'x',
    image: 'https://x/og-image.png',
    url: 'https://x/p/mug',
    jsonLd: { name: 'Mug </script><script>alert(1)</script>' },
  });
  assert.ok(!html.includes('<script>alert(1)'));
  assert.equal(jsonLd(html).name, 'Mug </script><script>alert(1)</script>');
});

test('robots.txt keeps private pages out and points to the sitemap', async () => {
  const res = await fetch(`${base}/robots.txt`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  const text = await res.text();
  assert.match(text, /^User-agent: \*$/m);
  for (const path of ['/admin', '/account', '/cart', '/checkout', '/orders', '/api/']) {
    assert.match(text, new RegExp(`^Disallow: ${path}$`, 'm'));
  }
  assert.ok(!/^Disallow: \/$/m.test(text)); // the shop itself stays open
  assert.match(text, new RegExp(`^Sitemap: ${base.replace('http://', 'https://')}/sitemap.xml$`, 'm'));
});

test('the sitemap lists the home page, every category and every shown product', async () => {
  const res = await fetch(`${base}/sitemap.xml`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/xml/);
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const shown = await t.db.collection('products').countDocuments({ active: true });
  assert.equal(locs.length, 1 + 6 + shown);
  assert.equal(locs[0], `${base}/`);
  assert.ok(locs.includes(`${base}/search?category=books`));
  assert.ok(locs.includes(`${base}/p/the-quiet-engineer-paperback`));
  assert.match(xml, /<lastmod>\d{4}-\d\d-\d\dT[\d:.]+Z<\/lastmod>/);

  await t.db.collection('products').updateOne({ slug: 'the-quiet-engineer-paperback' }, { $set: { active: false } });
  const after = await (await fetch(`${base}/sitemap.xml`)).text();
  assert.ok(!after.includes('/p/the-quiet-engineer-paperback<'));
  await t.db.collection('products').updateOne({ slug: 'the-quiet-engineer-paperback' }, { $set: { active: true } });
});

test("Google Search Console's verification tag is on every page when set", () => {
  const html = withSiteVerification(HTML, 'abc123_-XYZ');
  assert.ok(html.includes('<meta name="google-site-verification" content="abc123_-XYZ" />\n  </head>'));
  assert.equal(withSiteVerification(HTML, null), HTML);
});
