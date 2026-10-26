import { test, expect } from '@playwright/test';

// The demo never sends email, so the API tests cover the emails; this checks the switch and what the wishlist says.
test('the wishlist says price drops are emailed, and the account page switches them off and on', async ({ page }) => {
  const email = `drops-${Date.now()}@example.com`;
  await page.request.post('/api/auth/register', { data: { name: 'Kabir Das', email, password: 'password123' } });
  const book = await (await page.request.get('/api/products/the-quiet-engineer-paperback')).json();
  await page.request.put(`/api/wishlist/${book.id}`);

  await page.goto('/wishlist');
  await expect(page.getByText("We'll email you when anything here gets 5% cheaper or more.")).toBeVisible();
  await page.getByRole('link', { name: 'Change this' }).click();

  const box = page.getByRole('checkbox', { name: 'Tell me when something on my wishlist gets 5% cheaper or more' });
  await expect(box).toBeChecked();
  await box.click();
  await expect(page.getByRole('region', { name: 'Email updates' }).getByRole('status')).toHaveText(
    'Price-drop emails are off.',
  );
  await expect(box).not.toBeChecked();
  await page.reload();
  await expect(box).not.toBeChecked();

  await page.goto('/wishlist');
  await expect(page.getByText('Price-drop emails are off.')).toBeVisible();
  await page.getByRole('link', { name: 'Turn them on' }).click();
  await box.click();
  await expect(box).toBeChecked();
});
