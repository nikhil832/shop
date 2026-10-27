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

test('"Explain this error" says in plain words what a crash means and where to look', async ({ page, browser }) => {
  // The demo server's writing assistant talks to the stand-in Claude API (server/test/fake-anthropic.js).
  const message = `Cannot read properties of undefined (reading 'label') ${Date.now()}`;
  const visitor = (await browser.newContext()).request;
  const sent = await visitor.post('/api/error-reports', {
    data: {
      kind: 'crash',
      message,
      stack: `TypeError: ${message}\n    at DeliveryAddress (http://localhost/assets/index.js:1:2)`,
      componentStack: '\n    at DeliveryAddress\n    at Checkout',
      path: '/checkout',
    },
  });
  expect(sent.status()).toBe(204);

  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await page.goto('/admin/errors');
  const card = page.getByRole('listitem').filter({ hasText: message });
  await card.getByRole('button', { name: 'Explain this error' }).click();
  await expect(card.getByText('What it means')).toBeVisible();
  await expect(card.getByText('Can stop people buying')).toBeVisible();
  await expect(card.getByText('The page crashed. See [link removed] for more.')).toBeVisible();
  await expect(card.getByRole('listitem')).toHaveText('client/src/pages/Checkout.jsx: check the value before using it');

  // Kept with the report: it's still there after a reload, and can be asked again.
  await page.reload();
  await expect(card.getByText('What it means')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Explain again' })).toBeVisible();
});
