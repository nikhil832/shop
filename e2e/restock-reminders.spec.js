import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// The demo sends no email, so this checks the two switches: the product's days and the customer's preference. The
// sweep itself is tested in server/test/restockReminders.test.js.
test('admins set a restock reminder on a product, and customers can turn them off', async ({ page, browser }) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await admin.request.get('/api/categories')).json();
  const title = `Kitwell Coffee ${Date.now().toString(36)}`;
  const product = await (
    await admin.request.post('/api/admin/products', {
      data: { title, brand: 'Kitwell', categoryId: category.id, price: 39900, mrp: 44900, stock: 20 },
    })
  ).json();
  try {
    await admin.goto(`/admin/products/${product.id}`);
    const days = admin.getByLabel('Running-low reminder after (days, optional)');
    await expect(days).toHaveAccessibleDescription(/buyers get one email this long after delivery/);
    await days.fill('30');
    await admin.getByRole('button', { name: 'Save' }).click();
    await expect(admin).toHaveURL('/admin/products');
    await admin.goto(`/admin/products/${product.id}`);
    await expect(admin.getByLabel('Running-low reminder after (days, optional)')).toHaveValue('30');

    const email = `restock-${Date.now()}@example.com`;
    await page.request.post('/api/auth/register', { data: { name: 'Leela Das', email, password: 'password123' } });
    await page.goto('/account');
    const box = page.getByRole('checkbox', { name: 'Remind me when everyday things I bought may be running low' });
    await expect(box).toBeChecked();
    await box.click();
    await expect(page.getByText('Restock reminders are off.')).toBeVisible();
    await expect(box).not.toBeChecked();
    expect((await (await page.request.get('/api/auth/me')).json()).user.restockReminderEmails).toBe(false);
  } finally {
    await admin.request.patch(`/api/admin/products/${product.id}`, { data: { active: false } });
  }
});
