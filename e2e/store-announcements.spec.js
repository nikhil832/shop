import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function expectAccessible(page) {
  const { violations } = await new AxeBuilder({ page }).include('.announcement').withTags(WCAG).analyze();
  expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test('an admin puts a message across the shop; visitors see it, follow it, close it; it comes down', async ({
  page,
  browser,
}) => {
  const text = `Orders after 25 Oct ship after Diwali ${Date.now().toString(36)}`;
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await page.goto('/admin/announcements');
  await page.getByLabel('Message').fill(text);
  await page.getByLabel(/^Link/).fill('/help');
  await page.getByRole('button', { name: 'Schedule announcement' }).click();
  await expect(page.getByRole('status')).toHaveText('Announcement scheduled.');
  const row = page.getByRole('row').filter({ hasText: text });
  await expect(row).toContainText('Showing');

  try {
    // Not in the admin panel itself.
    await expect(page.getByRole('complementary', { name: 'Announcement' })).toHaveCount(0);

    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto('/');
    const bar = visitor.getByRole('complementary', { name: 'Announcement' });
    await expect(bar).toContainText(text);
    await expectAccessible(visitor);
    await visitor.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(visitor);

    // It stays across pages and its link leads into the store.
    await visitor.goto('/p/the-quiet-engineer-paperback');
    await expect(bar).toContainText(text);
    await bar.getByRole('link', { name: 'Find out more' }).click();
    await expect(visitor).toHaveURL('/help');

    // Closed, it stays closed, after a reload too.
    await bar.getByRole('button', { name: 'Close announcement' }).click();
    await expect(bar).toHaveCount(0);
    await visitor.reload();
    await expect(visitor.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(bar).toHaveCount(0);

    // A fixed typo shows to someone who hasn't closed it.
    await row.getByRole('button', { name: /^Edit/ }).click();
    await page.getByLabel('Message').fill(`${text}!`);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toHaveText('Announcement saved.');
    const fresh = await (await browser.newContext()).newPage();
    await fresh.goto('/');
    await expect(fresh.getByRole('complementary', { name: 'Announcement' })).toContainText(`${text}!`);
  } finally {
    await page
      .getByRole('row')
      .filter({ hasText: text })
      .getByRole('button', { name: /^End now/ })
      .click();
    await expect(page.getByRole('status')).toHaveText('Announcement taken down.');
  }
  await expect(page.getByRole('row').filter({ hasText: text })).toContainText('Ended');
  const after = await (await browser.newContext()).newPage();
  await after.goto('/');
  await expect(after.getByText('Top rated')).toBeVisible();
  await expect(after.getByRole('complementary', { name: 'Announcement' })).toHaveCount(0);
});
