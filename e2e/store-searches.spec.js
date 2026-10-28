import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

test('admins see what shoppers searched for and what found nothing', async ({ page, browser }) => {
  const nothing = `velvet hammock ${Date.now().toString(36)}`;
  // The search page's own addresses (what the header's box opens), so a remounting box can't drop typing.
  const shopper = await (await browser.newContext()).newPage();
  await shopper.goto('/search?q=running%20shoes');
  await expect(shopper.getByText('Stride Running Shoes').first()).toBeVisible();
  await shopper.goto(`/search?q=${encodeURIComponent(nothing)}`);
  await expect(shopper.getByRole('heading', { name: 'No products found' })).toBeVisible();

  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await page.goto('/admin');
  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Searches' }).click();
  const none = page.getByRole('region', { name: 'Found nothing' });
  await expect(none.getByRole('link', { name: nothing })).toBeVisible();
  const top = page.getByRole('region', { name: 'Most searched' });
  // Other spec files search on the same server ("running shoes under 2000"…), so the exact words.
  await expect(top.getByRole('link', { name: 'running shoes', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Week' })).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Each search opens the shop's results for it.
  await none.getByRole('link', { name: nothing }).click();
  await expect(page).toHaveURL(/\/search\?q=velvet/);
});
