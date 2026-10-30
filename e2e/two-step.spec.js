import { test, expect } from '@playwright/test';
import { codeAt, stepOf } from '../server/src/totp.js';

const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test('a customer turns on two-step login; logging in then asks for the code', async ({ page, browser }) => {
  const email = `two-step-${unique()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Name').fill('Asha Rao');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('banner').getByRole('button', { name: 'Asha' })).toBeVisible();

  await page.goto('/account');
  const section = page.getByRole('region', { name: 'Two-step login' });
  await section.getByLabel('Your password').fill('password123');
  await section.getByRole('button', { name: 'Set up two-step login' }).click();
  await expect(section.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  // What a phone app would do: read the key and make the current code.
  const secret = (await section.locator('.setup-key').textContent()).replace(/\s/g, '');
  await section.getByLabel(/Enter the 6-digit code/).fill('000000');
  await section.getByRole('button', { name: 'Turn on' }).click();
  await expect(section.getByRole('alert')).toContainText("That code doesn't match");
  await section.getByLabel(/Enter the 6-digit code/).fill(codeAt(secret, stepOf()));
  await section.getByRole('button', { name: 'Turn on' }).click();
  await expect(section.getByText('Save these recovery codes')).toBeVisible();
  await expect(section.locator('.recovery-codes code')).toHaveCount(8);
  await section.getByRole('button', { name: "I've saved them" }).click();
  await expect(section.getByText(/^On\./)).toBeVisible();

  // Another browser: the password alone isn't enough.
  const other = await browser.newPage();
  await other.goto('/login');
  await other.getByLabel('Email').fill(email);
  await other.getByLabel('Password').fill('password123');
  await other.getByRole('button', { name: 'Log in' }).click();
  await expect(other.getByRole('heading', { name: 'Two-step login' })).toBeVisible();
  await other.getByLabel('Code').fill('123456');
  await other.getByRole('button', { name: 'Log in' }).click();
  await expect(other.getByRole('alert')).toHaveText('That code is wrong or was already used');
  // The code used to turn it on can't be used again; the next one works.
  await other.getByLabel('Code').fill(codeAt(secret, stepOf() + 1));
  await other.getByRole('button', { name: 'Log in' }).click();
  await expect(other.getByRole('banner').getByRole('button', { name: 'Asha' })).toBeVisible();
  await other.close();
});

test('admins without two-step login are reminded in the admin panel', async ({ page }) => {
  await page.goto('/login?next=/admin');
  await page.getByLabel('Email').fill('admin@bazaar.demo');
  await page.getByLabel('Password').fill('demo-admin-123');
  await page.getByRole('button', { name: 'Log in' }).click();
  const note = page.getByRole('note');
  await expect(note).toContainText('Protect it with two-step login');
  await expect(note.getByRole('link', { name: 'two-step login' })).toHaveAttribute('href', '/account#two-step');
});
