import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// Its own product (hidden again at the end), with 8 in stock: not low at the default 5, low once warned at 10.
test("an admin sets a product's low-stock level and it shows as low", async ({ page }) => {
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await page.request.get('/api/categories')).json();
  const title = `Kitwell Tea ${Date.now().toString(36)}`;
  const product = await (
    await page.request.post('/api/admin/products', {
      data: { title, brand: 'Kitwell', categoryId: category.id, price: 29900, mrp: 34900, stock: 8 },
    })
  ).json();
  try {
    await page.goto(`/admin/products?status=low&q=${encodeURIComponent(title)}`);
    await expect(page.getByRole('heading', { name: 'Products', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: title })).toHaveCount(0);

    await page.goto(`/admin/products/${product.id}`);
    const level = page.getByLabel('Warn when this many are left (optional)');
    await expect(level).toHaveAccessibleDescription(/Empty: 5\./);
    await level.fill('10');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page).toHaveURL('/admin/products');

    await page.goto(`/admin/products?status=low&q=${encodeURIComponent(title)}`);
    await expect(page.getByRole('link', { name: title })).toBeVisible();
  } finally {
    await page.request.patch(`/api/admin/products/${product.id}`, { data: { active: false } });
  }
});
