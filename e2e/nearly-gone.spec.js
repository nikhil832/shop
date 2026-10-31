import { test, expect } from '@playwright/test';

// The demo sends no email, so this checks the customer's switch; the sweep is tested in
// server/test/nearlyGone.test.js.
test('customers can turn off "nearly gone" emails for their wishlist', async ({ page }) => {
  const email = `nearly-${Date.now()}@example.com`;
  await page.request.post('/api/auth/register', { data: { name: 'Tara Sen', email, password: 'password123' } });
  await page.goto('/account');
  const box = page.getByRole('checkbox', { name: 'Tell me when something on my wishlist is down to its last few' });
  await expect(box).toBeChecked();
  await box.click();
  await expect(page.getByText('Nearly-gone emails are off.')).toBeVisible();
  await expect(box).not.toBeChecked();
  expect((await (await page.request.get('/api/auth/me')).json()).user.nearlyGoneEmails).toBe(false);
});
