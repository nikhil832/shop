import { test, expect } from '@playwright/test';

test('Deals in the category bar lists the biggest discounts, and the home page has a row of them', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Biggest discounts' })).toBeVisible();

  await page.goto('/search?category=books');
  await page.getByRole('navigation', { name: 'Shop by category' }).getByRole('link', { name: 'Deals' }).click();
  await expect(page).toHaveURL('/search?deals=1&sort=discount');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Deals');
  await expect(page.getByRole('link', { name: 'Deals' }).first()).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('Sort by')).toHaveValue('discount');
  await expect(page.getByLabel('Deals: 40% off or more')).toBeChecked();

  // Biggest first: the first card's "N% off" is at least the second's.
  const percents = await page
    .locator('.product-grid .card .off')
    .evaluateAll((els) => els.map((e) => Number(e.textContent.match(/(\d+)%/)[1])));
  expect(percents.length).toBeGreaterThan(8);
  expect(percents.every((p) => p >= 40)).toBe(true);
  expect(percents).toEqual([...percents].sort((a, b) => b - a));

  // Unticking the filter keeps the order but shows every product.
  await page.getByLabel('Deals: 40% off or more').click();
  await expect(page.getByLabel('Deals: 40% off or more')).not.toBeChecked();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('All products');
});
