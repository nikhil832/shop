import { test, expect } from '@playwright/test';

// Against the stand-in on port 4103 (server/test/fake-google.js), which plays Google's "choose an account" page.
test('Continue with Google makes an account, logs in and comes back to the page asked for', async ({ page }) => {
  const email = `google-${Date.now().toString(36)}@example.com`;
  await page.goto('/login?next=/wishlist');
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('heading', { name: 'Choose an account' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Name').fill('Zoya Sheikh');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/wishlist$/);
  await expect(page.getByRole('button', { name: 'Zoya' })).toBeVisible();

  // The account page says it's linked, and that a password comes first to unlink.
  await page.goto('/account');
  const section = page.getByRole('region', { name: 'Google' });
  await expect(section).toContainText('You can log in with “Continue with Google”.');
  await expect(section).toContainText('set a password first');

  // Logged out, the same Google account logs in again.
  await page.getByRole('button', { name: 'Zoya' }).click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.goto('/login');
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: 'Zoya' })).toBeVisible();
});

test('cancelling on Google comes back to the login page and says so', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('alert')).toHaveText('Logging in with Google was cancelled.');
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
});
