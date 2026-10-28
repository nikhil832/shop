import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// Switched off again at the end: every spec shares this server.
test('an admin switches on cashback; the cart says how much will come back', async ({ page, browser }) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await admin.goto('/admin/coupons');
  const form = admin.getByRole('form', { name: 'Cashback' });
  try {
    await form.getByRole('checkbox', { name: 'Give cashback' }).check();
    await form.getByLabel('Percent back').fill('5');
    await form.getByLabel(/^At most per order/).fill('100');
    await form.getByRole('button', { name: 'Save cashback' }).click();
    await expect(form.getByRole('status')).toHaveText('Saved.');
    await expect(form).toContainText('On since');

    // ₹8,999 × 5% is ₹449: capped at ₹100.
    await page.goto('/p/orbit-a14-4gb-ram-64gb');
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await page.goto('/cart');
    await expect(page.getByText("You'll get ₹100 back as store credit, 7 days after delivery.")).toBeVisible();
  } finally {
    await admin.request.put('/api/admin/cashback', { data: { enabled: false, percent: 2, cap: 20000 } });
  }
  await page.reload();
  await expect(page.getByText(/back as store credit/)).toHaveCount(0);
});
