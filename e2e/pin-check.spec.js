import { test, expect } from '@playwright/test';

test('the PIN code fills in the state, and a state it is not in is flagged', async ({ page }) => {
  await page.request.post('/api/auth/register', {
    data: { name: 'Asha Rao', email: `pin-${Date.now()}@example.com`, password: 'password123' },
  });
  await page.goto('/p/the-quiet-engineer-paperback');
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await page.goto('/checkout');

  const state = page.getByLabel('State');
  // 682 is Kerala or Lakshadweep: nothing filled in. 560 is only Karnataka.
  await page.getByLabel('PIN code').fill('682001');
  await expect(state).toHaveValue('');
  await page.getByLabel('PIN code').fill('560001');
  await expect(state).toHaveValue('Karnataka');
  await expect(page.getByRole('alert')).toHaveCount(0);

  await state.fill('Kerala');
  await expect(page.getByRole('alert')).toHaveText('PIN code 560001 is in Karnataka. Check the state or the PIN code.');
  // Ordering anyway: the server refuses it too.
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByLabel('Address (house, street, area)').fill('12 MG Road');
  await page.getByLabel('City').fill('Bengaluru');
  await page.getByRole('radio', { name: /Cash on Delivery/ }).check();
  await page.getByRole('button', { name: /^Place order/ }).click();
  await expect(page.getByText('address.state: PIN code 560001 is in Karnataka, not Kerala')).toBeVisible();

  await state.fill('Karnataka');
  await expect(page.getByText('PIN code 560001 is in Karnataka. Check')).toHaveCount(0);
});
