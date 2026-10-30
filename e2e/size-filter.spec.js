import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('shoppers filter by size, and their size is offered on the next search', async ({ page }) => {
  await page.goto('/search?category=fashion');
  const sizes = page.getByRole('group', { name: 'Size' });
  await expect(sizes.getByRole('checkbox', { name: 'UK 8', exact: true })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).include('.size-filter').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);

  // Filter checkboxes follow the URL after navigation: click, then wait for the tick.
  await sizes.getByText('UK 8', { exact: true }).click();
  await expect(sizes.getByRole('checkbox', { name: 'UK 8', exact: true })).toBeChecked();
  await expect(page).toHaveURL(/size=UK(\+|%20)8/);
  await expect(page.locator('.product-grid .card')).toHaveCount(1);
  await expect(page.locator('.product-grid')).toContainText('Stride Running Shoes');

  // A new search with sizes offers the remembered one.
  await page.goto('/search?q=urbane');
  await page.goto('/search?category=fashion');
  await page.getByRole('button', { name: 'Show my sizes (UK 8)' }).click();
  await expect(
    page.getByRole('group', { name: 'Size' }).getByRole('checkbox', { name: 'UK 8', exact: true }),
  ).toBeChecked();
  await expect(page.locator('.product-grid .card')).toHaveCount(1);
});
