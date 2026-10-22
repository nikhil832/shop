import { test, expect } from '@playwright/test';

// The demo never sends email, so the API tests cover the email itself; this checks the button.
const SOLD_OUT = '/p/aura-electric-kettle-1-5l';
const uniqueEmail = () => `alert-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

test('a sold-out product offers an email alert instead of Add to cart', async ({ page }) => {
  await page.goto(SOLD_OUT);
  await expect(page.getByText('Out of stock')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to cart' })).toHaveCount(0);
  await page.getByRole('link', { name: "Log in to get an email when it's back" }).click();
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(SOLD_OUT)}`);

  const email = uniqueEmail();
  await page.request.post('/api/auth/register', { data: { name: 'Kavya Menon', email, password: 'password123' } });
  await page.goto(SOLD_OUT);
  await page.getByRole('button', { name: "Email me when it's back" }).click();
  await expect(page.getByRole('status')).toHaveText(`We'll email ${email} when it's back in stock.`);

  // Remembered on reload, and can be cancelled.
  await page.reload();
  await page.getByRole('button', { name: 'Cancel alert' }).click();
  await expect(page.getByRole('button', { name: "Email me when it's back" })).toBeVisible();
});
