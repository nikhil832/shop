import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

// Named to run after catalog.spec.js, since it adds a product. It changes only the product it adds.
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

async function logIn(page) {
  await page.goto('/login?next=%2Fadmin%2Fproducts');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/admin\/products/);
}

const upload = (page, name, text) =>
  page.getByLabel('CSV file').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });

test('an admin downloads the products, adds one from a file and changes it with another', async ({ page }) => {
  const title = `Brass Lamp ${Date.now()}`;
  await logIn(page);
  await page.getByRole('link', { name: 'Import / export CSV' }).click();
  await expect(page.getByRole('heading', { name: 'Import products' })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download products CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^products-\d{4}-\d\d-\d\d\.csv$/);
  const file = (await readFile(await download.path(), 'utf8')).replace(/^\uFEFF/, '');
  expect(file.split('\r\n')[0]).toBe(
    'Slug,Variant,Title,Brand,Category,Price (₹),MRP (₹),Cost (₹),Stock,Shown,Highlights,Description,Specifications,SKU,Barcode',
  );
  expect(file).toContain('the-quiet-engineer-paperback,');

  // A row with a problem: nothing can be saved.
  await upload(
    page,
    'bad.csv',
    `Title,Brand,Category,Price (₹),MRP (₹),Stock\n${title},Dhatu,Home & Kitchen,900,800,4\n`,
  );
  const preview = page.getByRole('region', { name: '3. Check and save' });
  await expect(preview.getByText('1 with problems')).toBeVisible();
  await expect(preview.getByText('MRP must be at least the price')).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Nothing to save' })).toBeDisabled();

  // Fixed: one new product.
  await upload(
    page,
    'new.csv',
    `Title,Brand,Category,Price (₹),MRP (₹),Stock\n${title},Dhatu,Home & Kitchen,899,1299,4\n`,
  );
  await expect(preview.getByText('1 new')).toBeVisible();
  await expect(preview.getByRole('row', { name: new RegExp(title) })).toContainText('Price ₹899');
  await preview.getByRole('button', { name: 'Save 1 row' }).click();
  await expect(page.getByRole('status')).toContainText('Saved: 1 added, 0 updated.');

  // Its slug comes from the title; a second file changes its price.
  const slug = title.toLowerCase().replaceAll(' ', '-');
  await upload(page, 'price.csv', `Slug,Price (₹)\n${slug},"1,099"\n`);
  await expect(preview.getByRole('row', { name: new RegExp(title) })).toContainText('Price ₹899 → ₹1,099');
  await preview.getByRole('button', { name: 'Save 1 row' }).click();
  await expect(page.getByRole('status')).toContainText('Saved: 0 added, 1 updated.');

  await page.goto(`/p/${slug}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.locator('.product-info')).toContainText('₹1,099');
});
