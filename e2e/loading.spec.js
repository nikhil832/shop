import { test, expect } from '@playwright/test';

// Pages loaded on first use (client/src/main.jsx): who downloads what, and what happens when a file is gone.

test('the admin panel and the invoice page load as their own files, only when opened', async ({ page }) => {
  const scripts = [];
  page.on('request', (r) => r.resourceType() === 'script' && scripts.push(new URL(r.url()).pathname));
  await page.goto('/p/the-quiet-engineer-paperback');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(scripts.some((s) => /AdminRoutes-/.test(s))).toBe(false);
  expect(scripts.some((s) => /Invoice-/.test(s))).toBe(false);
  await page.goto('/admin');
  await expect(
    page
      .getByRole('link', { name: 'Log in' })
      .or(page.getByRole('heading', { name: 'Log in' }))
      .first(),
  ).toBeVisible();
  expect(scripts.some((s) => /AdminRoutes-/.test(s))).toBe(true);
});

test('a page file gone after a deploy reloads the page once, then offers a Reload button', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Top rated')).toBeVisible();
  // The admin panel's file can't be fetched, as if a new build had replaced it.
  await page.route(/AdminRoutes-.*\.js$/, (route) => route.fulfill({ status: 404, body: 'Not found' }));
  const reloaded = page.waitForEvent('load');
  // Go to /admin inside the running app (as its links do), so the app itself fetches the file.
  await page.evaluate(() => {
    globalThis.history.pushState({}, '', '/admin');
    globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'));
  });
  await reloaded; // the first failure reloads the page
  // Still missing just after a reload: no loop, a message and a button instead of a blank page.
  await expect(page.getByRole('heading', { name: "This page didn't load" })).toBeVisible();
  await page.unroute(/AdminRoutes-.*\.js$/);
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(
    page.getByRole('heading', { name: 'Admins only' }).or(page.getByRole('heading', { name: 'Log in' })),
  ).toBeVisible();
});
