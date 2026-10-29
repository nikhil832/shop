import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// Its own product, hidden again at the end (a "Coming soon" row would show on everyone's home page).
test('an admin marks a product coming soon; shoppers see it with the expected day and ask to be told', async ({
  page,
  browser,
}) => {
  const stamp = Date.now().toString(36);
  const title = `Aurora Lamp ${stamp}`;
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const categories = await (await admin.request.get('/api/categories')).json();
  const created = await admin.request.post('/api/admin/products', {
    data: { title, brand: 'Griha', categoryId: categories[0].id, price: 129900, mrp: 159900, stock: 0 },
  });
  expect(created.ok()).toBe(true);
  const product = await created.json();
  const expected = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);

  try {
    await admin.goto(`/admin/products/${product.id}`);
    await admin.getByLabel('Coming soon (shown until it has stock)').check();
    await admin.getByLabel('Expected on (optional)').fill(expected);
    await admin.getByRole('button', { name: /^Save/ }).click();
    await expect(admin.getByRole('status').first()).toBeVisible();

    // A visitor: the badge, the day, and a way to be told (after logging in).
    await page.goto('/');
    const row = page.getByRole('region', { name: 'Coming soon' });
    await expect(row.getByRole('link', { name: new RegExp(title) })).toContainText('Coming soon');
    await page.goto(`/p/${product.slug}`);
    await expect(page.getByText(/^Coming soon · Expected /)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Log in to get an email when it arrives' })).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);

    expect(
      (
        await page.request.post('/api/auth/register', {
          data: { name: 'Isha Menon', email: `soon-${stamp}@example.com`, password: 'password123' },
        })
      ).ok(),
    ).toBe(true);
    await page.reload();
    await page.getByRole('button', { name: 'Email me when it arrives' }).click();
    await expect(page.getByRole('status')).toContainText('when it arrives');

    // Stock arrives: it's an ordinary product again.
    expect((await admin.request.patch(`/api/admin/products/${product.id}`, { data: { stock: 7 } })).ok()).toBe(true);
    await page.reload();
    await expect(page.getByText('In stock', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add to cart' })).toBeEnabled();
  } finally {
    await admin.request.patch(`/api/admin/products/${product.id}`, { data: { active: false } });
  }
});
