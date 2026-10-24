import { test, expect } from '@playwright/test';

const row = (page, name) => page.getByRole('region', { name });

test('a product page shows similar products from its category', async ({ page }) => {
  await page.goto('/p/voltix-nova-5g-8gb-ram-128gb');
  const similar = row(page, 'Similar products');
  await expect(similar.getByRole('link').first()).toContainText('Voltix Nova Pro 5G');
  await expect(similar.getByRole('link', { name: /Voltix Nova 5G \(8GB/ })).toHaveCount(0);

  // Following one goes to that product, with its own similar products.
  await similar.getByRole('link').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Voltix Nova Pro 5G (12GB RAM, 256GB)');
  await expect(row(page, 'Similar products').getByRole('link').first()).toContainText('Voltix Nova 5G (8GB');
});

test('recently viewed products follow the visitor, newest first, until cleared', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Top rated' })).toBeVisible();
  await expect(row(page, 'Recently viewed')).toHaveCount(0);

  await page.goto('/p/the-quiet-engineer-paperback');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // The page doesn't list itself.
  await expect(row(page, 'Recently viewed')).toHaveCount(0);

  await page.goto('/p/voltix-nova-5g-8gb-ram-128gb');
  const recent = row(page, 'Recently viewed');
  await expect(recent.getByRole('link')).toHaveCount(1);
  await expect(recent.getByRole('link')).toContainText('The Quiet Engineer');

  await page.goto('/');
  const cards = row(page, 'Recently viewed').getByRole('link');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('Voltix Nova 5G');
  await expect(cards.nth(1)).toContainText('The Quiet Engineer');
  await expect(cards.nth(1)).toContainText('₹349');

  await row(page, 'Recently viewed').getByRole('button', { name: 'Clear' }).click();
  await expect(row(page, 'Recently viewed')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Top rated' })).toBeVisible();
  await expect(row(page, 'Recently viewed')).toHaveCount(0);
});
