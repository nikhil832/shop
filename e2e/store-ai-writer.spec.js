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

test('"Draft an answer" fills in a reply to a question for the admin to check and send', async ({ page, browser }) => {
  // A customer asks two questions: one the details answer, one they don't (the stand-in says so for warranties).
  const customer = (await (await browser.newContext()).newPage()).request;
  const stamp = Date.now();
  await customer.post('/api/auth/register', {
    data: { name: 'Meera Iyer', email: `draft-${stamp}@example.com`, password: 'password123' },
  });
  const ask = (text) => customer.post('/api/products/aura-electric-kettle-1-5l/questions', { data: { text } });
  const known = `Is the body steel? (${stamp})`;
  const unsure = `What is the warranty? (${stamp})`;
  expect((await ask(known)).ok()).toBe(true);
  expect((await ask(unsure)).ok()).toBe(true);

  await page.goto('/login?next=%2Fadmin%2Fquestions');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible();

  const card = page.getByRole('listitem').filter({ hasText: known });
  await card.getByRole('button', { name: 'Draft an answer' }).click();
  await expect(card.getByLabel('Your answer')).toHaveValue(
    'Yes: Aura Electric Kettle 1.5L comes with what the description lists.',
  );
  await expect(card.getByText('Draft written from the product’s details')).toBeVisible();
  await card.getByLabel('Your answer').fill('Yes: stainless steel inside and out.');
  await card.getByRole('button', { name: 'Answer', exact: true }).click();
  await expect(card).toHaveCount(0); // answered: moved to Answered

  const other = page.getByRole('listitem').filter({ hasText: unsure });
  await other.getByRole('button', { name: 'Draft an answer' }).click();
  await expect(other.getByText('The product’s details don’t settle this')).toBeVisible();
});
