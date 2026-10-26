import { test, expect } from '@playwright/test';

// The demo server serves the production build, so these are the pages a link preview would read.
const meta = (html, key) => html.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)" />`))?.[1];

test("a product link's HTML carries its preview, before any JavaScript runs", async ({ request }) => {
  const res = await request.get('/p/the-quiet-engineer-paperback');
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(meta(html, 'og:title')).toBe('The Quiet Engineer (Paperback) · ₹349');
  expect(meta(html, 'og:image')).toMatch(/^http:\/\/localhost:\d+\/og-image\.png$/);
  expect(html).toContain('<title>The Quiet Engineer (Paperback) · ₹349</title>');

  const image = await request.get('/og-image.png');
  expect(image.status()).toBe(200);
  expect(image.headers()['content-type']).toBe('image/png');

  const home = await (await request.get('/')).text();
  expect(meta(home, 'og:title')).toBe('Bazaar');
  expect((await request.get('/p/no-such-product')).status()).toBe(404);
});

test('the app still runs on those pages, and names the product in the tab', async ({ page }) => {
  await page.goto('/p/the-quiet-engineer-paperback');
  await expect(page.getByRole('heading', { name: 'The Quiet Engineer (Paperback)' })).toBeVisible();
  await expect(page).toHaveTitle('The Quiet Engineer (Paperback) · Bazaar');
  await page.goto('/');
  await expect(page.getByText('Top rated')).toBeVisible();
});

test('search engines get robots.txt, a sitemap and product data from the built site', async ({ request }) => {
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toContain('Disallow: /admin');
  expect(robots).toMatch(/^Sitemap: http:\/\/localhost:\d+\/sitemap\.xml$/m);

  const sitemap = await request.get('/sitemap.xml');
  expect(sitemap.headers()['content-type']).toContain('application/xml');
  expect(await sitemap.text()).toMatch(/<loc>http:\/\/localhost:\d+\/p\/the-quiet-engineer-paperback<\/loc>/);

  const html = await (await request.get('/p/the-quiet-engineer-paperback')).text();
  const data = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
  expect(data.offers.price).toBe('349.00');
});

test('built files are cached for good; pages and unknown files are not', async ({ request }) => {
  const html = await (await request.get('/')).text();
  const script = html.match(/src="(\/assets\/[^"]+\.js)"/)[1];
  const res = await request.get(script);
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  expect((await request.get('/')).headers()['cache-control']).toBe('no-cache');
  // A file from an older build: a plain 404, so the page knows to reload instead of running HTML as code.
  expect((await request.get('/assets/index-old.js')).status()).toBe(404);
});
