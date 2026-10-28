import { test, expect } from '@playwright/test';

// A PNG's width and height, from its header.
const pngSize = (buffer) => [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];

test('the store can be installed as an app: a manifest, icons at their sizes, and a theme colour', async ({
  page,
  request,
}) => {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/');
  await expect(page.getByText('Top rated')).toBeVisible();
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#1e3a8a');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/icon.svg');

  const res = await request.get('/manifest.webmanifest');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/^application\/manifest\+json/);
  const manifest = await res.json();
  expect(manifest).toMatchObject({ name: 'Bazaar', start_url: '/', scope: '/', display: 'standalone' });
  // What phones need to offer installing it: a 192 and a 512 icon, and one they may crop to their own shape.
  expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  for (const icon of [...manifest.icons, { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }]) {
    const file = await request.get(icon.src);
    expect(file.status(), icon.src).toBe(200);
    expect(file.headers()['content-type'], icon.src).toContain(icon.type);
    if (icon.type === 'image/png') {
      expect(pngSize(await file.body()).join('x'), icon.src).toBe(icon.sizes);
    }
  }
  // Chrome's own check of whether it would offer to install the site (what Lighthouse uses). Test browsers are
  // private windows, which Chrome never installs from; any reason beyond that would be the site's.
  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  expect(installabilityErrors.map((e) => e.errorId).filter((id) => id !== 'in-incognito')).toEqual([]);
  // The browser fetched the manifest and icon without the security policy or anything else complaining.
  expect(errors).toEqual([]);
});
