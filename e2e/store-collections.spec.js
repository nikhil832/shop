import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// Deleted again at the end: a collection on the home page shows for every spec on this shared server.
test('an admin picks products for a collection; it has its own page and a home page row until switched off', async ({
  page,
  browser,
}) => {
  const stamp = Date.now().toString(36);
  const name = `Monsoon picks ${stamp}`;
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  try {
    await admin.goto('/admin/collections');
    const form = admin.getByRole('form', { name: 'New collection' });
    await form.getByLabel('Name').fill(name);
    await form.getByLabel('Description (optional)').fill('Reads and runs for rainy days.');
    for (const [search, title] of [
      ['quiet engineer', 'The Quiet Engineer (Paperback)'],
      ['stride', 'Stride Running Shoes'],
    ]) {
      await form.getByLabel('Find products').fill(search);
      await form.getByRole('button', { name: `Add ${title}`, exact: true }).click();
    }
    const chosen = form.getByRole('list', { name: 'Products in the collection' });
    await chosen.getByRole('button', { name: 'Up Stride Running Shoes' }).click();
    await expect(chosen.getByRole('listitem').first()).toContainText('Stride Running Shoes');
    await expect(form.getByLabel('Show it on the home page')).toBeChecked();
    expect(
      (await new AxeBuilder({ page: admin }).include('.panel').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    ).toEqual([]);
    await form.getByRole('button', { name: 'Add collection' }).click();
    await expect(admin.getByRole('status')).toHaveText(`“${name}” added.`);
    const row = admin.getByRole('row', { name: new RegExp(name) });
    await expect(row).toContainText('2 products · on the home page');
    await expect(row).toContainText('Live');

    // A visitor opens its page, in the order chosen, and finds it on the home page.
    const slug = `monsoon-picks-${stamp}`;
    await page.goto(`/c/${slug}`);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(page.getByText('Reads and runs for rainy days.')).toBeVisible();
    await expect(page.locator('.product-grid .card-title')).toHaveText([
      'Stride Running Shoes',
      'The Quiet Engineer (Paperback)',
    ]);
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
    await page.goto('/');
    const homeRow = page.getByRole('region', { name });
    await expect(homeRow.locator('.card-title')).toHaveCount(2);
    await homeRow.getByRole('link', { name: 'View all' }).click();
    await expect(page).toHaveURL(`/c/${slug}`);

    // Switched off: gone for visitors, still viewable by the admin.
    await row.getByRole('button', { name: `Edit ${name}` }).click();
    const edit = admin.getByRole('form', { name: `Edit ${name}` });
    await edit.getByLabel('Shown (untick to switch it off)').uncheck();
    await edit.getByRole('button', { name: 'Save collection' }).click();
    await expect(admin.getByRole('status')).toHaveText(`“${name}” saved.`);
    await expect(row).toContainText('Off');
    await page.reload();
    await expect(page.getByText("This collection isn't available.")).toBeVisible();
    await admin.goto(`/c/${slug}`);
    await expect(admin.getByRole('status')).toContainText('Only admins can see this');
  } finally {
    const { items } = await (await admin.request.get('/api/admin/collections')).json();
    for (const c of items.filter((x) => x.name === name)) await admin.request.delete(`/api/admin/collections/${c.id}`);
  }
});
