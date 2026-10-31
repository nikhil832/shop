import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// Its own product (hidden again at the end). YouTube is never reached: its player address answers with a stand-in.
test('an admin adds a YouTube video; the product page loads the player only when asked to', async ({
  page,
  browser,
}) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await admin.request.get('/api/categories')).json();
  const title = `Kitwell Blender ${Date.now().toString(36)}`;
  const res = await admin.request.post('/api/admin/products', {
    data: { title, brand: 'Kitwell', categoryId: category.id, price: 249900, mrp: 299900, stock: 5 },
  });
  expect(res.status()).toBe(201);
  const product = await res.json();
  try {
    await admin.goto(`/admin/products/${product.id}`);
    const field = admin.getByLabel('YouTube video (optional)');
    await field.fill('https://vimeo.com/123456789');
    await admin.getByRole('button', { name: 'Save changes' }).click();
    await expect(admin.getByRole('alert')).toHaveText('video: Paste a link to a YouTube video');
    await field.fill('https://youtu.be/dQw4w9WgXcQ?si=shared');
    await admin.getByRole('button', { name: 'Save changes' }).click();
    await expect(admin.getByRole('status')).toContainText(`Saved “${title}”.`);

    const youtube = [];
    const blocked = [];
    page.on('request', (r) => r.url().includes('youtube') && youtube.push(r.url()));
    page.on('console', (m) => m.text().includes('Content Security Policy') && blocked.push(m.text()));
    await page.route('https://www.youtube-nocookie.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Player</title><p>Stand-in player</p>' }),
    );

    await page.goto(`/p/${product.slug}`);
    const button = page.getByRole('button', { name: /Watch the video/ });
    await expect(button).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).include('.gallery').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    ).toEqual([]);
    expect(youtube).toEqual([]); // nothing from YouTube until play is pressed

    await button.click();
    const player = page.locator(`iframe[title="Video of ${title}"]`);
    await expect(player).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0');
    await expect(player).toBeFocused();
    await expect(page.frameLocator(`iframe[title="Video of ${title}"]`).getByText('Stand-in player')).toBeVisible();
    expect(blocked).toEqual([]); // the security policy lets the player in
  } finally {
    await admin.request.patch(`/api/admin/products/${product.id}`, { data: { active: false } });
  }
});
