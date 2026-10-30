import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const BOOK = '/p/the-quiet-engineer-paperback';
const cart = (page, n) => page.getByRole('link', { name: `Cart, ${n} ${n === 1 ? 'item' : 'items'}` });

test('items move from the cart to "Saved for later" and back', async ({ page }) => {
  // A guest is asked to log in first.
  await page.goto(BOOK);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await page.goto('/cart');
  await expect(page.getByRole('link', { name: 'Log in to save for later' })).toBeVisible();

  await page.request.post('/api/auth/register', {
    data: { name: 'Asha Rao', email: `later-${Date.now()}@example.com`, password: 'password123' },
  });
  // Shoes with sizes on the wishlist too: they go back through their page to choose a size.
  const shoes = await (await page.request.get('/api/products/stride-running-shoes')).json();
  await page.request.put(`/api/wishlist/${shoes.id}`);
  await page.goto('/cart');
  await expect(cart(page, 1)).toBeVisible();

  await page.getByRole('button', { name: 'Save for later: The Quiet Engineer (Paperback)' }).click();
  await expect(cart(page, 0)).toBeVisible();
  const saved = page.getByRole('region', { name: /^Saved for later/ });
  await expect(saved.getByRole('heading')).toHaveText('Saved for later (2)');
  await expect(saved.getByRole('link', { name: 'Choose a size: Stride Running Shoes' })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).include('.saved-for-later').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);

  await saved.getByRole('button', { name: 'Move to cart: The Quiet Engineer (Paperback)' }).click();
  await expect(cart(page, 1)).toBeVisible();
  await expect(saved.getByRole('heading')).toHaveText('Saved for later (1)');
  await expect(page.getByRole('heading', { name: 'Cart (1)' })).toBeVisible();
});
