import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Filter by specification (stage 138), on the sample phones' specs (RAM 4, 8 and 12 GB). Read-only: no data changes.
const cards = (page) => page.locator('.product-grid .card');

test('shoppers filter a category by its specifications', async ({ page }) => {
  await page.goto('/search?category=mobiles');
  const ram = page.getByRole('group', { name: 'RAM', exact: true });
  await expect(ram.getByLabel('8 GB (1)')).toBeVisible();
  expect((await new AxeBuilder({ page }).include('.filters').analyze()).violations).toEqual([]);

  const eight = ram.getByRole('checkbox', { name: '8 GB' });
  await eight.click();
  await expect(eight).toBeChecked();
  await expect(page).toHaveURL(/spec=RAM%3A8\+GB/);
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText('Voltix Nova 5G');

  // Another value of the same name adds to the results; another name narrows them.
  const twelve = ram.getByRole('checkbox', { name: '12 GB' });
  await twelve.click();
  await expect(twelve).toBeChecked();
  await expect(cards(page)).toHaveCount(2);
  const storage = page.getByRole('group', { name: 'Storage', exact: true });
  await expect(storage.getByLabel('64 GB (0)')).toBeVisible();
  const big = storage.getByRole('checkbox', { name: '256 GB' });
  await big.click();
  await expect(big).toBeChecked();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText('Voltix Nova Pro 5G');

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).not.toHaveURL(/spec=/);
  await expect(ram.getByRole('checkbox', { name: '8 GB' })).not.toBeChecked();
});
