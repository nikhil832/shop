import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// A product shown today is "New" on its card and page. Bestsellers come from a minute sweep of real orders, so they're
// tested in the API tests; here the badge is put on a sample product's response in the browser to check how it looks.
test('"New" and "Bestseller" badges on cards and product pages', async ({ page, browser }) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await admin.request.get('/api/categories')).json();
  const stamp = Date.now().toString(36);
  const title = `Kitwell Lamp ${stamp}`;
  const made = await (
    await admin.request.post('/api/admin/products', {
      data: { title, brand: 'Kitwell', categoryId: category.id, price: 49900, mrp: 59900, stock: 8 },
    })
  ).json();
  try {
    await page.goto(`/search?q=${encodeURIComponent(`kitwell lamp ${stamp}`)}`);
    const card = page.locator('.card').filter({ hasText: title });
    await expect(card.locator('.card-badge')).toHaveText('New');
    // The badge is beside the card's link, so the link is still named by the product.
    await expect(card.getByRole('link')).not.toContainText('New');
    await page.goto(`/p/${made.slug}`);
    await expect(page.locator('.page-badge')).toHaveText('New');

    // A bestseller, as the server would say once enough customers buy it.
    await page.route('**/api/products/the-quiet-engineer-paperback', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), badge: 'bestseller' } });
    });
    await page.goto('/p/the-quiet-engineer-paperback');
    await expect(page.locator('.page-badge')).toHaveText(/^Bestseller in /);
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      expect(
        (await new AxeBuilder({ page }).include('.page-badge').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      ).toEqual([]);
    }
  } finally {
    await admin.request.patch(`/api/admin/products/${made.id}`, { data: { active: false } });
  }
});
