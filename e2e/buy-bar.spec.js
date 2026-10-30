import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const BOOK = '/p/the-quiet-engineer-paperback';
const SHOES = '/p/stride-running-shoes';
const bar = (page) => page.getByRole('region', { name: 'Buy' });
// Down to the reviews, so the page's own buttons are out of view.
const scrollDown = (page) => page.getByRole('heading', { name: 'Questions & answers' }).scrollIntoViewIfNeeded();

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the buy bar stays at the bottom while scrolling, and adds or buys from there', async ({ page }) => {
    await page.goto(BOOK);
    await expect(page.getByRole('heading', { name: 'The Quiet Engineer (Paperback)' })).toBeVisible();
    await scrollDown(page);
    await expect(bar(page)).toBeVisible();
    await expect(bar(page)).toContainText('₹349');
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      expect(
        (await new AxeBuilder({ page }).include('.buy-bar').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
        colorScheme,
      ).toEqual([]);
    }
    await bar(page).getByRole('button', { name: 'Add to cart' }).click();
    await expect(page.getByRole('link', { name: 'Cart, 1 item' })).toBeVisible();
    await bar(page).getByRole('button', { name: 'Buy now' }).click();
    await expect(page).toHaveURL('/checkout');
  });

  test('before a size is chosen, the bar takes you to the sizes', async ({ page }) => {
    await page.goto(SHOES);
    await scrollDown(page);
    await bar(page).getByRole('button', { name: 'Choose a size' }).click();
    await expect(page.getByRole('alert')).toHaveText('Choose a size first');
    await expect(page.getByRole('group', { name: /^Size/ }).getByRole('button', { name: 'UK 7' })).toBeFocused();
    // The page's own buttons are in view again, so the bar steps aside.
    await expect(bar(page)).toHaveCount(0);
  });
});

test('there is no buy bar on a wide screen', async ({ page }) => {
  await page.goto(BOOK);
  await scrollDown(page);
  await expect(bar(page)).toBeHidden();
});
