import { test, expect } from '@playwright/test';

// Named to run after catalog.spec.js: it adds a product (hidden again at the end), so its counts are its own.
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test('views and adds to cart from the product page show on Admin → Products → Performance', async ({
  page,
  browser,
}) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const categories = await (await admin.request.get('/api/categories')).json();
  const books = categories.find((c) => c.slug === 'books');
  const title = `Watched Planner ${unique()}`;
  const planner = await (
    await admin.request.post('/api/admin/products', {
      data: { title, brand: 'Kagaz', categoryId: books.id, price: 29900, mrp: 29900, stock: 10 },
    })
  ).json();
  try {
    // A visitor opens it twice and adds it to the cart once.
    const seen = [];
    page.on('request', (r) => r.url().endsWith(`/api/products/${planner.slug}/seen`) && seen.push(r));
    await page.goto(`/p/${planner.slug}`);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await expect.poll(() => seen.length).toBe(3);

    // The admin's own visit isn't counted.
    await admin.goto(`/p/${planner.slug}`);
    await expect(admin.getByRole('heading', { name: title })).toBeVisible();

    await admin.goto('/admin/products');
    await admin.getByRole('link', { name: 'Performance' }).click();
    await admin.getByLabel('Period').selectOption('7');
    const row = admin.getByRole('row').filter({ hasText: title });
    await expect(row.getByRole('cell')).toHaveText([title, '2', '1', '0', '0', '0%']);
  } finally {
    await admin.request.patch(`/api/admin/products/${planner.id}`, { data: { active: false } });
  }
});
