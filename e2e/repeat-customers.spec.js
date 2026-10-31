import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// Other specs' customers are on the shared server too, so this checks the panel's shape; the figures are tested in
// server/test/repeatCustomers.test.js.
test('the dashboard shows new and returning customers', async ({ page }) => {
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const { customers } = await (await page.request.get('/api/admin/dashboard?days=7')).json();
  expect(customers.new + customers.returning).toBe(customers.customers);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin');
  const panel = page.getByRole('region', { name: 'Repeat customers' });
  await expect(panel).toContainText(/Since the store opened, \d+ of \d+ customers? ha(ve|s) bought more than once/);
  if (customers.customers > 0) {
    await expect(panel).toContainText(`${customers.new} new and ${customers.returning} returning`);
    await expect(panel.getByRole('definition').first()).toBeVisible();
  }
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(
    (await new AxeBuilder({ page }).include('.repeat-customers').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
});
