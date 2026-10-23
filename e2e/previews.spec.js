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
