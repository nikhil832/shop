import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const axe = (page) => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();

test('an admin records a delivery: stock goes up, the cost price is averaged, the history says why', async ({
  page,
}) => {
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await page.request.get('/api/categories')).json();
  const title = `Brass Lamp ${Date.now().toString(36)}`;
  const lamp = await (
    await page.request.post('/api/admin/products', {
      data: { title, brand: 'Dhatu', categoryId: category.id, price: 59900, mrp: 79900, stock: 5, cost: 20000 },
    })
  ).json();

  // From the product's stock history, which starts the form with it.
  await page.goto(`/admin/products/${lamp.id}/stock`);
  await page.getByRole('link', { name: 'Receive stock' }).click();
  await expect(page.getByRole('heading', { name: 'Record a delivery' })).toBeVisible();
  await expect(page.getByRole('cell', { name: new RegExp(title) })).toContainText('5 in stock · cost now ₹200');
  await page.getByLabel('Supplier').fill('Mehta Traders');
  await page.getByLabel(/^Their invoice number/).fill('INV-2231');
  await page.getByLabel('Received of line 1').fill('15');
  await page.getByLabel('Price each of line 1').fill('240');
  expect((await axe(page)).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await page.getByRole('button', { name: 'Add to stock' }).click();

  // 5 at ₹200 and 15 at ₹240: 20 at ₹230.
  await expect(page.getByRole('heading', { name: /^Delivery #\d+ from Mehta Traders$/ })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: title });
  await expect(row).toContainText('+15');
  await expect(row).toContainText('5 → 20');
  await expect(row).toContainText('₹200 → ₹230');
  expect((await axe(page)).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await row.getByRole('link', { name: title }).click();
  const latest = page.getByRole('row').nth(1);
  await expect(latest).toContainText('+15');
  await expect(latest).toContainText(/Received · Delivery #\d+ · Demo Admin/);

  await page.goto('/admin/stock-receipts');
  await expect(page.getByRole('row').filter({ hasText: 'Mehta Traders' }).first()).toContainText('₹3,600');
});
