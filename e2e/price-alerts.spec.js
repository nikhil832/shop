import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Price alerts on the wishlist (stage 142). Only this customer's wishlist changes; product prices stay as they are.
const SLUG = 'the-quiet-engineer-paperback'; // ₹349
const TITLE = 'The Quiet Engineer (Paperback)';

test('a customer sets, changes and removes a price alert on a wishlist item', async ({ page }) => {
  await page.request.post('/api/auth/register', {
    data: { name: 'Isha Roy', email: `alert-${Date.now().toString(36)}@example.com`, password: 'password123' },
  });
  const book = await (await page.request.get(`/api/products/${SLUG}`)).json();
  expect((await page.request.put(`/api/wishlist/${book.id}`)).ok()).toBe(true);

  await page.goto('/wishlist');
  const row = page.locator('.wish-row').filter({ hasText: TITLE });
  await row.getByRole('button', { name: /^Set a price alert/ }).click();
  const form = row.getByRole('form', { name: `Price alert for ${TITLE}` });
  // Today's price is refused by the server too (the box's own limit is checked by the browser first).
  await form.getByLabel('Email me at (₹) or less').evaluate((el) => el.removeAttribute('max'));
  await form.getByLabel('Email me at (₹) or less').fill('349');
  await form.getByRole('button', { name: 'Save alert' }).click();
  await expect(form.getByRole('alert')).toHaveText("It's ₹349 now: choose a lower price");

  await form.getByLabel('Email me at (₹) or less').fill('299');
  await form.getByRole('button', { name: 'Save alert' }).click();
  await expect(row).toContainText("We'll email you at ₹299 or less.");
  expect((await new AxeBuilder({ page }).include('.wish-row').analyze()).violations).toEqual([]);

  // Kept after a reload; changed; removed.
  await page.reload();
  await expect(row).toContainText("We'll email you at ₹299 or less.");
  await row.getByRole('button', { name: /^Change/ }).click();
  await row.getByLabel('Email me at (₹) or less').fill('279');
  await row.getByRole('button', { name: 'Save alert' }).click();
  await expect(row).toContainText("We'll email you at ₹279 or less.");
  await row.getByRole('button', { name: /^Remove alert/ }).click();
  await expect(row.getByRole('button', { name: /^Set a price alert/ })).toBeVisible();
});
