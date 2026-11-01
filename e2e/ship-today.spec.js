import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Ship-today countdown (stage 139). Switched off again at the end: every spec shares one demo server.
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

test('an admin sets a cut-off and product pages count down to it', async ({ page, browser }) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  try {
    await admin.goto('/admin/delivery');
    const form = admin.getByRole('form', { name: 'Ship-today countdown' });
    await form.getByLabel('Show the countdown on product pages').check();
    // Every day until a minute before midnight, so it ships today whenever the test runs.
    await form.getByLabel('Cut-off time').fill('23:59');
    await form.getByLabel('Sunday').check();
    await form.getByRole('button', { name: 'Save the countdown' }).click();
    await expect(form.getByRole('status')).toHaveText('Saved.');
    expect(
      (await new AxeBuilder({ page: admin }).include('form[aria-labelledby="dispatch-cutoff"]').analyze()).violations,
    ).toEqual([]);

    await page.goto('/p/the-quiet-engineer-paperback');
    await expect(page.locator('.ships-today')).toHaveText(
      /^(Order within (\d+ h ?)?(\d+ min)? to ship today|Ships tomorrow)$/,
    );
  } finally {
    const current = await (await admin.request.get('/api/admin/dispatch')).json();
    await admin.request.put('/api/admin/dispatch', { data: { ...current, enabled: false } });
  }
  await page.goto('/p/the-quiet-engineer-paperback');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('.ships-today')).toHaveCount(0);
});
