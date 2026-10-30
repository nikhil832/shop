import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Named to run after catalog.spec.js: it adds a product (hidden again at the end). Only that product is counted, so
// the shared server's other stock is left alone.
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test('an admin counts a category: the sheet, the differences, then the stock put right', async ({ page }) => {
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const categories = await (await page.request.get('/api/categories')).json();
  const books = categories.find((c) => c.slug === 'books');
  const title = `Counted Notebook ${unique()}`;
  const notebook = await (
    await page.request.post('/api/admin/products', {
      data: { title, brand: 'Kagaz', categoryId: books.id, price: 9900, mrp: 9900, stock: 5 },
    })
  ).json();
  try {
    await page.goto('/admin/stocktakes');
    await page.getByLabel('What to count').selectOption({ label: 'Books' });
    await page.getByRole('button', { name: 'Start a count' }).click();
    const sheet = page.getByRole('form', { name: 'Count sheet: Books' });
    await expect(sheet).toBeVisible();
    const row = sheet.getByRole('row').filter({ hasText: title });
    await expect(row.getByRole('cell').nth(1)).toHaveText('5'); // on the shelf

    await row.getByLabel(`Counted: ${title}`).fill('3');
    await sheet.getByRole('button', { name: 'Check 1 count' }).click();
    await expect(sheet.getByRole('status')).toHaveText('1 row changes: −2 units against what should be on the shelf.');
    await expect(row).toContainText('5 → 3');
    expect(
      (await new AxeBuilder({ page }).include('.stocktake').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    ).toEqual([]);

    // Typed counts survive a reload until saved.
    await page.reload();
    await expect(sheet.getByLabel(`Counted: ${title}`)).toHaveValue('3');
    await sheet.getByRole('button', { name: 'Check 1 count' }).click();
    await sheet.getByLabel('Note (optional)').fill('Shelf B');
    await sheet.getByRole('button', { name: 'Save the count' }).click();

    await expect(page.getByRole('heading', { name: /^Stocktake #\d+: Books$/ })).toBeVisible();
    await expect(page.getByText('Shelf B')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: title })).toContainText('5 → 3');
    const stocktakeUrl = page.url();

    // The stock history shows it, linked back.
    await page.goto(`/admin/products/${notebook.id}/stock`);
    const entry = page.getByRole('row').filter({ hasText: 'Stocktake' }).first();
    await expect(entry).toContainText('−2');
    await entry.getByRole('link', { name: /^Stocktake #/ }).click();
    await expect(page).toHaveURL(stocktakeUrl);

    // The draft is gone once saved.
    await page.goto(`/admin/stocktakes/new?category=${books.id}`);
    await expect(page.getByLabel(`Counted: ${title}`)).toHaveValue('');
  } finally {
    await page.request.patch(`/api/admin/products/${notebook.id}`, { data: { active: false } });
  }
});
