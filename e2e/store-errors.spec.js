import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

test('a page that did not load is reported, and admins see it and mark it fixed', async ({ page, browser }) => {
  await page.goto('/');
  await expect(page.getByText('Top rated')).toBeVisible();
  // The admin panel's file is gone, and the page already reloaded once for it, so it says it didn't load.
  await page.route(/AdminRoutes-.*\.js$/, (route) => route.fulfill({ status: 404, body: 'Not found' }));
  await page.evaluate(() => globalThis.sessionStorage.setItem('bazaar.reloadedAt', String(Date.now())));
  const reported = page.waitForRequest((r) => r.url().endsWith('/api/error-reports') && r.method() === 'POST');
  await page.evaluate(() => {
    globalThis.history.pushState({}, '', '/admin?tab=x#token=secret');
    globalThis.dispatchEvent(new globalThis.PopStateEvent('popstate'));
  });
  await expect(page.getByRole('heading', { name: "This page didn't load" })).toBeVisible();
  const body = (await reported).postDataJSON();
  expect(body).toMatchObject({ kind: 'load', path: '/admin?tab=x' });
  expect(body.message).toMatch(/AdminRoutes/);

  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await admin.goto('/admin');
  await expect(admin.getByRole('link', { name: /reported from browsers/ })).toBeVisible();
  await admin.getByRole('link', { name: /reported from browsers/ }).click();
  await expect(admin.getByRole('heading', { name: 'Errors' })).toBeVisible();
  const card = admin.getByRole('listitem').filter({ hasText: 'AdminRoutes' }).first();
  await expect(card).toContainText("Page didn't load");
  await expect(card).toContainText('/admin?tab=x');
  await card.getByText('Details for fixing it').click();
  await expect(card.getByText(/Latest browser:/)).toBeVisible();
  await card.getByRole('button', { name: 'Mark fixed' }).click();
  await expect(admin.getByRole('listitem').filter({ hasText: 'AdminRoutes' })).toHaveCount(0);
  await admin.getByRole('button', { name: /^Fixed/ }).click();
  await expect(admin.getByRole('listitem').filter({ hasText: 'AdminRoutes' }).first()).toContainText('Marked fixed');
});
