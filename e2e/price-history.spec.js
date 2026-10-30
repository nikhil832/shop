import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// A week of price history can't be made on the shared server, so the product response gets one in the browser.
async function withInsight(page, priceInsight) {
  await page.route('**/api/products/the-quiet-engineer-paperback', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), priceInsight } });
  });
  await page.goto('/p/the-quiet-engineer-paperback');
}

test('the product page says when the price is the lowest in 30 days, or what the lowest was', async ({ page }) => {
  await withInsight(page, { days: 30, lowest: 34900, isLowest: true });
  await expect(page.getByText('Lowest price in 30 days')).toBeVisible();
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    expect(
      (await new AxeBuilder({ page }).include('.lowest-price').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    ).toEqual([]);
  }

  await page.unrouteAll();
  await withInsight(page, { days: 12, lowest: 29900, isLowest: false });
  await expect(page.getByText('Lowest in the last 12 days: ₹299')).toBeVisible();
  await expect(page.getByText(/^Lowest price in/)).toHaveCount(0);
});

test('nothing is claimed without enough history', async ({ page }) => {
  await page.goto('/p/the-quiet-engineer-paperback');
  await expect(page.getByRole('heading', { name: 'The Quiet Engineer (Paperback)' })).toBeVisible();
  await expect(page.getByText(/Lowest (price in|in the last)/)).toHaveCount(0);
});
