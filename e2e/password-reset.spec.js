import { test, expect } from '@playwright/test';

// The demo server never sends email, so the full reset (with a real link) is covered by the API tests;
// these check the pages around it.

test('the forgot-password form answers without saying whether the account exists', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('heading', { name: 'Forgot your password?' })).toBeVisible();
  await page.getByLabel('Email').fill('nobody-here@example.com');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText("If there's an account for nobody-here@example.com");
});

test('the reset page needs a link, matching passwords and a live token', async ({ page }) => {
  await page.goto('/reset-password');
  await expect(page.getByText('This page needs the link from your reset email')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Get a new link' })).toHaveAttribute('href', '/forgot-password');

  await page.goto(`/reset-password#token=${'x'.repeat(43)}`);
  await page.getByLabel('New password').fill('new password 1');
  await page.getByLabel('Type it again').fill('new password 2');
  await page.getByRole('button', { name: 'Save and log in' }).click();
  await expect(page.getByRole('alert')).toHaveText("The two passwords don't match");

  await page.getByLabel('Type it again').fill('new password 1');
  await page.getByRole('button', { name: 'Save and log in' }).click();
  await expect(page.getByRole('alert')).toContainText('This reset link has expired or was already used.');
  await expect(page.getByRole('alert').getByRole('link', { name: 'Get a new link' })).toBeVisible();
});

test('after 5 wrong passwords the login form says the email is paused', async ({ page }) => {
  const email = `locked-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  for (let i = 0; i < 4; i++) {
    await page.getByLabel('Password').fill(`wrong ${i}`);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Wrong email or password');
  }
  await page.getByLabel('Password').fill('wrong 4');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Too many wrong passwords for this email. Try again in 15 minutes, or reset your password.',
  );
  await expect(page.getByRole('link', { name: 'Forgot password?' })).toBeVisible();
});
