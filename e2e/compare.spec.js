import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test('a shopper ticks products from one category and compares them side by side', async ({ page }) => {
  await page.goto('/search?category=fashion');
  const tick = (title) => page.getByRole('checkbox', { name: `Compare ${title}` });
  const tray = page.getByRole('complementary', { name: 'Products to compare' });

  await tick('Stride Running Shoes').click();
  await expect(tick('Stride Running Shoes')).toBeChecked();
  await expect(tray).toContainText('Stride Running Shoes');
  await expect(tray).toContainText('Choose one or two more from this category');
  await tick('Urbane Men Slim Fit Jeans').click();
  await expect(tick('Urbane Men Slim Fit Jeans')).toBeChecked();
  await tick('Ziva Women Handbag').click();
  await expect(tick('Ziva Women Handbag')).toBeChecked();
  // Three is the most: the others can't be ticked now.
  await expect(tick('Urbane Women Kurta Set')).toBeDisabled();

  // The list survives moving around, and the product page shows its tick too.
  await page.goto('/p/stride-running-shoes');
  await expect(page.getByRole('checkbox', { name: 'Compare Stride Running Shoes' })).toBeChecked();
  await tray.getByRole('link', { name: 'Compare 3' }).click();

  await expect(page.getByRole('heading', { name: 'Compare fashion' })).toBeVisible();
  await expect(tray).toHaveCount(0);
  const table = page.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveCount(3);
  await expect(table.getByRole('row', { name: /^Options/ })).toContainText('Blue / 30 (sold out)');
  await expect(table.getByRole('row', { name: /^Stock/ })).toContainText('In stock');
  await expect(table.getByRole('link', { name: 'Choose a size of Stride Running Shoes' })).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Removing one here updates the address and this browser's list.
  await table.getByRole('button', { name: 'Remove Ziva Women Handbag' }).click();
  await expect(page).toHaveURL('/compare?slugs=stride-running-shoes%2Curbane-men-slim-fit-jeans');
  await expect(table.getByRole('columnheader')).toHaveCount(2);

  // A product from another category starts a new list.
  await page.goto('/search?category=books');
  await page
    .getByRole('checkbox', { name: /^Compare / })
    .first()
    .click();
  await expect(tray).toContainText('Products are compared within one category, so this starts a new list.');
  await expect(tray.getByRole('listitem')).toHaveCount(1);
  await tray.getByRole('button', { name: 'Clear' }).click();
  await expect(tray).toHaveCount(0);
});

test('a shared comparison opens straight away; with nothing in it, the page says so', async ({ page }) => {
  await page.goto('/compare?slugs=the-quiet-engineer-paperback,learning-to-code-with-javascript');
  await expect(page.getByRole('heading', { name: 'Compare books' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to cart The Quiet Engineer (Paperback)' })).toBeVisible();
  await page.goto('/compare');
  await expect(page.getByRole('heading', { name: 'Nothing to compare' })).toBeVisible();
});
