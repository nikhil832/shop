import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// The demo sends no email, so the code itself can't be read here: the API tests log in with one.
test('the login page offers an emailed code instead of the password', async ({ page }) => {
  const email = `code-${Date.now()}@example.com`;
  await page.request.post('/api/auth/register', { data: { name: 'Asha Rao', email, password: 'password123' } });
  await page.request.post('/api/auth/logout');

  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an email code instead' }).click();
  const form = page.getByRole('form', { name: 'Log in with an email code' });
  await form.getByLabel('Email').fill(email);
  await form.getByRole('button', { name: 'Email me a code' }).click();
  await expect(form.getByRole('status')).toContainText(`If ${email} has an account, we've emailed it a 6-digit code.`);
  expect(
    (await new AxeBuilder({ page }).include('.auth-form').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);

  // A wrong code is refused (the real one is in the email).
  await form.getByLabel('Code').fill('000000');
  await form.getByRole('button', { name: 'Log in' }).click();
  await expect(form.getByRole('alert')).toHaveText(/That code is wrong|expired/);

  await form.getByRole('button', { name: 'Use my password instead' }).click();
  await expect(page.getByLabel('Password')).toBeVisible();
});
