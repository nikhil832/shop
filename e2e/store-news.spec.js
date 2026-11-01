import { test, expect } from '@playwright/test';

// Store news emails (stage 140). The demo sends no email (it only logs), so this checks the opt-in, writing, testing
// and queueing; unsubscribing by token is covered by the API tests (the browser never sees a token).
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

test('a customer opts in, and an admin writes, tests and sends store news', async ({ page, browser }) => {
  const stamp = Date.now().toString(36);
  await page.request.post('/api/auth/register', {
    data: { name: 'Nisha Pai', email: `news-${stamp}@example.com`, password: 'password123' },
  });
  await page.goto('/account#updates');
  const box = page.getByLabel('Send me store news: new arrivals and sales, now and then');
  await expect(box).not.toBeChecked();
  await box.click();
  await expect(page.getByText('Store news emails are on.')).toBeVisible();
  await expect(box).toBeChecked();

  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await admin.goto('/admin/news');
  await expect(admin.getByRole('heading', { name: 'Store news', level: 1 })).toBeVisible();
  await expect(admin.getByText(/customers? (has|have) asked for store news/)).toBeVisible();
  await admin.getByRole('button', { name: 'Write an email' }).click();
  const form = admin.getByRole('form', { name: 'New email' });
  const subject = `Fresh arrivals ${stamp}`;
  await form.getByLabel('Subject').fill(subject);
  await form.getByLabel(/^Text/).fill('New things are in.\n\nCome and have a look.');
  await form.getByLabel(/^Button link/).fill('/search?deals=1');
  await form.getByRole('button', { name: 'Save draft' }).click();
  await expect(admin.getByRole('status')).toHaveText('Draft saved. Send yourself a test before sending it out.');

  const row = admin.getByRole('row').filter({ hasText: subject });
  await row.getByRole('button', { name: /^Send me a test/ }).click();
  await expect(admin.getByRole('status')).toHaveText('A test went to admin@bazaar.demo.');

  admin.once('dialog', (d) => d.accept());
  await row.getByRole('button', { name: /^Send to subscribers/ }).click();
  await expect(admin.getByRole('status')).toHaveText('Sending. It goes out over the next minutes.');
  await expect(row).toContainText('Sending');
  await expect(row.getByRole('button', { name: /^Edit/ })).toHaveCount(0);

  // The unsubscribe page wants a click; a made-up link is refused.
  await page.goto('/unsubscribe#token=not-a-real-token-at-all');
  await page.getByRole('button', { name: 'Unsubscribe from store news' }).click();
  await expect(page.getByRole('alert')).toHaveText('This unsubscribe link is not valid');
});
