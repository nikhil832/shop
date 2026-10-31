import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// The demo has three sample questions; this adds its own (deleted again at the end) and checks it everywhere.
test('admins write questions and answers; shoppers read and search them', async ({ page, browser }) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const word = `kiosk${Date.now().toString(36)}`;
  const question = `Can I collect my order from the ${word}?`;
  try {
    await admin.goto('/admin/help');
    await admin.getByRole('link', { name: 'FAQ', exact: true }).click();
    const form = admin.getByRole('form', { name: 'Add a question' });
    await form.getByLabel('Question', { exact: true }).fill(question);
    await form.getByLabel('Answer').fill('Not yet.\n\nEvery order is delivered to the address you give.');
    await form.getByLabel('Topic').selectOption({ label: 'Delivery' });
    await form.getByRole('button', { name: 'Add' }).click();
    await expect(admin.getByRole('status')).toHaveText('Added.');
    await expect(admin.getByRole('region', { name: 'Delivery' })).toContainText(question);

    // The shop's page: grouped by topic, each answer opened by a click.
    await page.goto('/');
    await page.getByRole('contentinfo').getByRole('link', { name: 'Questions and answers' }).click();
    await expect(page.getByRole('heading', { name: 'Questions and answers', level: 1 })).toBeVisible();
    const entry = page.locator('details').filter({ hasText: question });
    await expect(entry.getByText('Every order is delivered')).toBeHidden();
    await entry.getByText(question).click();
    await expect(entry.getByText('Every order is delivered to the address you give.')).toBeVisible();
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      expect(
        (await new AxeBuilder({ page }).include('.faq-page').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      ).toEqual([]);
    }

    // Search: only matching answers, already open.
    await page.getByLabel('Search the questions').fill(word);
    await expect(page.getByText('1 answer found.')).toBeVisible();
    await expect(page.locator('details')).toHaveCount(1);
    await page.getByLabel('Search the questions').fill('nothing-like-this');
    await expect(page.getByText('Nothing found.')).toBeVisible();

    // The Help page searches them above the contact form.
    await page.goto('/help');
    await page.getByLabel('Search our answers first').fill(word);
    await expect(page.getByText('Every order is delivered to the address you give.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'See all questions and answers' })).toBeVisible();

    // Hidden: gone from the shop, still in the admin list.
    await admin.getByRole('button', { name: `Edit ${question}` }).click();
    await admin
      .getByRole('form', { name: `Edit "${question}"` })
      .getByLabel('Shown in the shop')
      .uncheck();
    await admin.getByRole('button', { name: 'Save' }).click();
    await expect(admin.getByRole('status')).toHaveText('Saved.');
    await page.goto('/faq');
    await expect(page.getByRole('heading', { name: 'Delivery' })).toBeVisible();
    await expect(page.getByText(question)).toHaveCount(0);
  } finally {
    const { topics } = await (await admin.request.get('/api/admin/faq')).json();
    for (const item of topics.flatMap((g) => g.items).filter((i) => i.question === question)) {
      await admin.request.delete(`/api/admin/faq/${item.id}`);
    }
  }
});
