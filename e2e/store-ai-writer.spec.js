import { test, expect } from '@playwright/test';

// The demo server's writing assistant talks to a stand-in Claude API (server/test/fake-anthropic.js, started by
// playwright.config.js), so this never calls the real one. Nothing is saved.
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

test('"Write for me" fills in the highlights and description for the admin to check', async ({ page }) => {
  await page.goto('/login?next=%2Fadmin%2Fproducts%2Fnew');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Add product' })).toBeVisible();

  // Without a title yet, the server says what's missing.
  await page.getByRole('button', { name: 'Write for me' }).click();
  await expect(page.getByRole('alert')).toContainText('Enter a title first');

  await page.getByLabel('Title').fill('Griha Ceramic Vase');
  await page.getByLabel('Brand').fill('Griha');
  await page.getByLabel('Category').selectOption({ label: 'Home & Kitchen' });
  await page.getByLabel(/^Highlights/).fill('Hand-glazed');
  await page.getByRole('button', { name: 'Write for me' }).click();
  await expect(page.getByLabel(/^Highlights/)).toHaveValue('Easy to use\nBuilt to last\nGreat value');
  await expect(page.getByLabel('Description')).toHaveValue(/^Griha Ceramic Vase is a dependable pick/);
  await expect(page.getByText('Draft written. Check every detail before saving')).toBeVisible();

  // With a description there, it asks before replacing it; saying no keeps the admin's edit.
  await page.getByLabel('Description').fill('My own words.');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Write for me' }).click();
  await expect(page.getByLabel('Description')).toHaveValue('My own words.');
});
