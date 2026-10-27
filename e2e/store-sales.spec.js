import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const VACUUM = '/p/aura-robot-vacuum'; // ₹14,999: 20% off is ₹11,999

test('an admin schedules a sale; the store shows sale prices and the countdown until it ends', async ({ page }) => {
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await page.goto('/admin/sales');
  const form = page.getByRole('form', { name: 'New sale' });
  await form.getByLabel('Name').fill('Spring clean');
  await form.getByLabel('Percent off').fill('20');
  await form.getByRole('radio', { name: 'Chosen products' }).check();
  await form.getByLabel('Find products').fill('robot vacuum');
  await form.getByRole('button', { name: 'Add Aura Robot Vacuum' }).click();
  await expect(form.getByRole('list', { name: 'Products in the sale' })).toContainText('Aura Robot Vacuum');
  await form.getByRole('button', { name: 'Schedule sale' }).click();
  await expect(page.getByRole('status')).toHaveText('“Spring clean” scheduled.');
  const row = page.getByRole('row').filter({ hasText: 'Spring clean' });
  await expect(row).toContainText('Running');
  await expect(row).toContainText('1 on sale');

  try {
    await page.goto(VACUUM);
    await expect(page.locator('.product-info .price')).toHaveText('₹11,999');
    await expect(page.getByText(/Spring clean · Sale ends in 6 days/)).toBeVisible();
    await page.goto('/search?q=robot%20vacuum');
    await expect(page.getByRole('link', { name: /Aura Robot Vacuum/ }).first()).toContainText('Sale');
  } finally {
    await page.goto('/admin/sales');
    await page
      .getByRole('row')
      .filter({ hasText: 'Spring clean' })
      .getByRole('button', { name: /End now/ })
      .click();
    await expect(page.getByRole('status')).toHaveText('“Spring clean” ended; prices are back.');
  }
  await page.goto(VACUUM);
  await expect(page.locator('.product-info .price')).toHaveText('₹14,999');
  await expect(page.getByText(/Sale ends/)).toHaveCount(0);
});
