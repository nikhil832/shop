import { test, expect } from '@playwright/test';

const cards = (page) => page.locator('.product-grid .card');

// Filter checkboxes reflect the URL, so they update once navigation finishes; check() would look too early.
async function tick(locator) {
  await locator.click();
  await expect(locator).toBeChecked();
}
const resultCount = (page) => page.locator('.results-header .muted');

test('home shows categories and product rows', async ({ page }) => {
  await page.goto('/');
  const categories = page.getByRole('navigation', { name: 'Categories' }).getByRole('link');
  await expect(categories).toHaveText(['Mobiles', 'Laptops', 'Audio', 'Fashion', 'Home & Kitchen', 'Books']);
  await expect(page.getByRole('heading', { name: 'Top rated' })).toBeVisible();
  await expect(page.locator('.product-row').first().locator('.card')).toHaveCount(8);

  await categories.filter({ hasText: 'Laptops' }).click();
  await expect(page).toHaveURL(/\/search\?category=laptops$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Laptops');
  await expect(resultCount(page)).toHaveText('6 products');
});

test('searching from the header lists matches and keeps the query in the box', async ({ page }) => {
  await page.goto('/');
  const box = page.getByRole('searchbox', { name: 'Search products' });
  await box.fill('sonique');
  await box.press('Enter');

  await expect(page).toHaveURL(/\/search\?q=sonique$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Results for “sonique”');
  await expect(cards(page)).toHaveCount(2);
  await expect(box).toHaveValue('sonique');

  await box.fill('zzzz');
  await box.press('Enter');
  await expect(page.getByRole('heading', { name: 'No products found' })).toBeVisible();

  // Back restores the previous search, including the text in the box.
  await page.goBack();
  await expect(cards(page)).toHaveCount(2);
  await expect(box).toHaveValue('sonique');
});

test('filters and sorting update the URL and the results', async ({ page }) => {
  await page.goto('/search?category=mobiles');
  await expect(resultCount(page)).toHaveText('7 products');

  await tick(page.getByRole('checkbox', { name: /Voltix/ }));
  await expect(page).toHaveURL(/brand=Voltix/);
  await expect(resultCount(page)).toHaveText('2 products');
  await tick(page.getByRole('checkbox', { name: /Orbit/ }));
  await expect(resultCount(page)).toHaveText('4 products');

  await page.getByRole('combobox', { name: 'Sort by' }).selectOption('price_asc');
  await expect(cards(page).locator('.card-title')).toHaveText([
    'Orbit A14 (4GB RAM, 64GB)',
    'Voltix Nova 5G (8GB RAM, 128GB)',
    'Voltix Nova Pro 5G (12GB RAM, 256GB)',
    'Orbit X Fold',
  ]);

  await page.getByLabel('Maximum price').fill('20000');
  await page.getByRole('button', { name: 'Go' }).click();
  await expect(page).toHaveURL(/maxPrice=20000/);
  await expect(resultCount(page)).toHaveText('2 products');

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(resultCount(page)).toHaveText('7 products');
  await expect(page).toHaveURL(/\/search\?category=mobiles&sort=price_asc$/);
});

test('in-stock filter hides sold-out products', async ({ page }) => {
  await page.goto('/search?category=books');
  await expect(page.locator('.ribbon', { hasText: 'Out of stock' })).toHaveCount(1);
  await tick(page.getByRole('checkbox', { name: 'In stock only' }));
  await expect(resultCount(page)).toHaveText('4 products');
  await expect(page.locator('.ribbon')).toHaveCount(0);
});

test('paginates long result lists', async ({ page }) => {
  await page.goto('/search');
  await expect(resultCount(page)).toHaveText('38 products');
  await expect(cards(page)).toHaveCount(24);
  await expect(page.getByText('Page 1 of 2')).toBeVisible();
  await expect(page.getByRole('button', { name: '‹ Previous' })).toBeDisabled();

  await page.getByRole('button', { name: 'Next ›' }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(cards(page)).toHaveCount(14);
  await expect(page.getByRole('button', { name: 'Next ›' })).toBeDisabled();
});

test('product page shows details, price and gallery', async ({ page }) => {
  await page.goto('/search?q=arcbook%20pro');
  await cards(page).first().click();

  await expect(page).toHaveURL('/p/arcbook-pro-16-32gb-1tb-ssd');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Arcbook Pro 16 (32GB, 1TB SSD)');
  await expect(page.locator('.product-info .price')).toHaveText('₹1,49,990');
  await expect(page.locator('.product-info .off')).toHaveText('12% off');
  await expect(page.getByText('Only 4 left')).toBeVisible();
  await expect(page.locator('.highlights li')).toHaveText(['16" mini-LED', '12-core CPU', '22-hour battery']);

  const thumb2 = page.getByRole('button', { name: 'Show image 2' });
  await thumb2.click();
  await expect(thumb2).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Laptops' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Laptops');
});

test('unknown products and pages show not found', async ({ page }) => {
  await page.goto('/p/no-such-thing');
  await expect(page.getByText("This product doesn't exist or is no longer sold.")).toBeVisible();
  await page.goto('/nowhere');
  await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to home' }).click();
  await expect(page.getByRole('heading', { name: 'Top rated' })).toBeVisible();
});
