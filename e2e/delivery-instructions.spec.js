import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

test('delivery instructions from checkout reach the order and the packing slip, and can be changed', async ({
  page,
  browser,
}) => {
  await page.request.post('/api/auth/register', {
    data: { name: 'Asha Rao', email: `note-${Date.now()}@example.com`, password: 'password123' },
  });
  await page.goto('/p/the-quiet-engineer-paperback');
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await page.goto('/checkout');
  for (const [label, value] of Object.entries({
    'Mobile number': '9876543210',
    'Address (house, street, area)': '12 MG Road',
    City: 'Bengaluru',
    State: 'Karnataka',
    'PIN code': '560001',
  })) {
    await page.getByLabel(label).fill(value);
  }
  await page.getByLabel('Delivery instructions (optional)').fill('Call before coming');
  await page.getByRole('radio', { name: /Cash on Delivery/ }).check();
  await page.getByRole('button', { name: /^Place order/ }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f]{24}$/);
  const orderId = page.url().split('/').pop();

  const panel = page.getByRole('region', { name: 'Delivery address' });
  await expect(panel).toContainText('Delivery instructions: Call before coming');
  await panel.getByRole('button', { name: 'Change instructions' }).click();
  const form = panel.getByRole('form', { name: 'Delivery instructions' });
  expect(
    (await new AxeBuilder({ page }).include('.instructions-form').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await form.getByLabel('Delivery instructions').fill('Leave it with the security guard');
  await form.getByRole('button', { name: 'Save instructions' }).click();
  await expect(panel).toContainText('Delivery instructions: Leave it with the security guard');

  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await admin.goto(`/admin/orders/slips?ids=${orderId}`);
  await expect(admin.locator('.slip')).toContainText('Delivery instructions: Leave it with the security guard');
});
