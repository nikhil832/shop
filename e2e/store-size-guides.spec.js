import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// Deleted again at the end: every spec shares this server.
test('an admin adds a size guide for Fashion; shoe pages offer it in a dialog', async ({ page }) => {
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await page.goto('/admin/size-guides');
  const form = page.getByRole('form', { name: 'New size guide' });
  await form.getByLabel('Name').fill('Shoe sizes');
  await form.getByLabel(/^Table/).fill('UK, EU, Foot length (cm)\n7, 41, 25.4\n8, 42, 26.0\n9, 43, 26.7');
  await form.getByLabel(/^Note/).fill('Measure your foot from heel to toe.');
  await form.getByRole('checkbox', { name: 'Fashion' }).check();
  await form.getByRole('button', { name: 'Add size guide' }).click();
  await expect(page.getByRole('status')).toHaveText('Size guide added.');
  try {
    await page.goto('/p/stride-running-shoes');
    await page.getByRole('button', { name: 'Size guide' }).click();
    const dialog = page.getByRole('dialog', { name: 'Shoe sizes' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('row').nth(2)).toHaveText('84226.0');
    await expect(dialog).toContainText('Measure your foot from heel to toe.');
    expect(
      (await new AxeBuilder({ page }).include('.size-guide').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    ).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // Products without options have nothing to size.
    await page.goto('/p/the-quiet-engineer-paperback');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Size guide' })).toHaveCount(0);
  } finally {
    const { items } = await (await page.request.get('/api/admin/size-guides')).json();
    for (const g of items.filter((x) => x.name === 'Shoe sizes'))
      await page.request.delete(`/api/admin/size-guides/${g.id}`);
  }
});
