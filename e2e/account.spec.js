import { test, expect } from '@playwright/test';

const uniqueEmail = () => `account-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

test('the account page changes the name, saved address and password', async ({ page }) => {
  const email = uniqueEmail();
  await page.goto('/register');
  await page.getByLabel('Name').fill('Asha Rao');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('banner').getByRole('link', { name: 'Asha' })).toBeVisible();
  await page.goto('/orders');
  await page.getByRole('link', { name: 'Account' }).click();
  await expect(page).toHaveURL('/account');

  // Name: the header greets the new first name.
  const details = page.getByRole('form', { name: 'Your details' });
  await details.getByLabel('Name').fill('Meera Iyer');
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(details.getByRole('status')).toHaveText('Saved');
  await expect(page.getByRole('banner').getByRole('link', { name: 'Meera' })).toBeVisible();

  // Address: saved, then filled in at checkout's form after a reload.
  const address = page.getByRole('form', { name: 'Saved address' });
  await address.getByLabel('Mobile number').fill('9876543210');
  await address.getByLabel('Address (house, street, area)').fill('12 MG Road');
  await address.getByLabel('City').fill('Bengaluru');
  await address.getByLabel('State').fill('Karnataka');
  await address.getByLabel('PIN code').fill('560001');
  await address.getByRole('button', { name: 'Save address' }).click();
  await expect(address.getByRole('status')).toHaveText('Saved. Checkout will fill this in.');
  await page.reload();
  await expect(page.getByRole('form', { name: 'Saved address' }).getByLabel('City')).toHaveValue('Bengaluru');

  // Password: the current one is required and can't be reused.
  const password = page.getByRole('form', { name: 'Change password' });
  await password.getByLabel('Current password').fill('password123');
  await password.getByLabel(/^New password/).fill('password123');
  await password.getByLabel('Type the new password again').fill('password123');
  await password.getByRole('button', { name: 'Change password' }).click();
  await expect(password.getByRole('alert')).toHaveText('Your new password must be different from your current one.');

  await password.getByLabel(/^New password/).fill('brand new password');
  await password.getByLabel('Type the new password again').fill('brand new password');
  await password.getByRole('button', { name: 'Change password' }).click();
  await expect(password.getByRole('status')).toHaveText(
    "Password changed. You've been logged out on your other devices.",
  );
  await expect(password.getByLabel('Current password')).toHaveValue('');

  // The new password works for a fresh login.
  const res = await page.request.post('/api/auth/login', { data: { email, password: 'brand new password' } });
  expect(res.ok()).toBe(true);
});

test('the account page needs a login', async ({ page }) => {
  await page.goto('/account');
  await expect(page).toHaveURL('/login?next=/account');
});
