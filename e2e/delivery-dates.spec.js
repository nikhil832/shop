import { test, expect } from '@playwright/test';

// The India-time date `n` days from now, as the store writes it: "Thu, 31 Oct".
const day = (n) =>
  new Date(Date.now() + 330 * 60_000 + n * 86_400_000).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

test('checkout says when the order arrives for the PIN code typed; the order page keeps saying it', async ({
  page,
}) => {
  await page.request.post('/api/auth/register', {
    data: { name: 'Asha Rao', email: `dates-${Date.now()}@example.com`, password: 'password123' },
  });
  await page.goto('/p/the-quiet-engineer-paperback');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.goto('/checkout');
  const summary = page.getByRole('complementary', { name: 'Order summary' });
  await expect(summary).not.toContainText('Arrives');

  for (const [label, value] of Object.entries({
    'Mobile number': '9876543210',
    'Address (house, street, area)': '12 MG Road',
    City: 'Bengaluru',
    State: 'Karnataka',
    'PIN code': '560001',
  })) {
    await page.getByLabel(label).fill(value);
  }
  // Everywhere without its own delivery area: 3 to 7 days.
  const promise = `between ${day(3)} and ${day(7)}`;
  await expect(summary).toContainText(`Arrives ${promise}`);
  await page.getByRole('radio', { name: /Cash on Delivery/ }).check();
  await page.getByRole('button', { name: 'Place order · ₹389' }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f]{24}$/);
  await expect(page.getByText(`should arrive ${promise}`)).toBeVisible();
});
