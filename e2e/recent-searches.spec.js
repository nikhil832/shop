import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('the empty search box offers recent searches, newest first, until cleared', async ({ page }) => {
  await page.goto('/');
  const box = () => page.getByRole('combobox', { name: 'Search products' });
  for (const term of ['headphones', 'book', 'Headphones']) {
    await box().fill(term);
    await box().press('Enter');
    await expect(page).toHaveURL(`/search?q=${term}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(term); // the header has redrawn too
  }

  // Focusing the empty box lists them (one "headphones", whatever its case), and the arrows and Enter work as usual.
  await box().fill('');
  await box().blur();
  await box().focus();
  const list = page.getByRole('listbox', { name: 'Recent searches' });
  await expect(list.getByRole('option')).toHaveText(['Headphones', 'book', 'Clear recent searches']);
  expect(
    (await new AxeBuilder({ page }).include('.search-form').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await box().press('ArrowDown');
  await box().press('ArrowDown');
  await box().press('Enter');
  await expect(page).toHaveURL('/search?q=book');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('book');

  // Typing replaces them with suggestions; emptying the box brings them back.
  await box().fill('so');
  await expect(page.getByRole('listbox', { name: 'Search suggestions' })).toBeVisible();
  await box().fill('');
  await expect(list.getByRole('option')).toHaveText(['book', 'Headphones', 'Clear recent searches']);

  await list.getByRole('option', { name: 'Clear recent searches' }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await page.reload();
  await box().fill('');
  await box().focus();
  await expect(box()).toHaveAttribute('aria-expanded', 'false');
});
