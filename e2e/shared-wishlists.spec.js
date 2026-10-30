import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const axe = async (page, selector) =>
  (await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa']).analyze()).violations;

test('a customer shares their wishlist; a friend opens the link and adds a present to their cart', async ({
  page,
  browser,
}) => {
  await page.request.post('/api/auth/register', {
    data: { name: 'Asha Rao', email: `share-${Date.now()}@example.com`, password: 'password123' },
  });
  for (const slug of ['the-quiet-engineer-paperback', 'orbit-a14-4gb-ram-64gb']) {
    const { id } = await (await page.request.get(`/api/products/${slug}`)).json();
    await page.request.put(`/api/wishlist/${id}`);
  }
  await page.goto('/wishlist');
  const panel = page.getByRole('region', { name: 'Share your wishlist' });
  await panel.getByRole('button', { name: 'Share my wishlist' }).click();
  const link = panel.getByLabel('Link to your wishlist');
  await expect(link).toHaveValue(/\/w\/[\w-]{24}$/);
  expect(await axe(page, '.share-wishlist')).toEqual([]);
  const url = await link.inputValue();

  const friend = await (await browser.newContext()).newPage();
  await friend.goto(url);
  await expect(friend.getByRole('heading', { name: "Asha's wishlist" })).toBeVisible();
  await expect(friend.locator('.product-grid .card')).toHaveCount(2);
  expect(await axe(friend, '.shared-wishlist')).toEqual([]);
  await friend.getByRole('button', { name: 'Add The Quiet Engineer (Paperback) to cart' }).click();
  await expect(friend.getByRole('link', { name: 'Cart, 1 item' })).toBeVisible();

  // Stopped: the link finds nothing.
  await panel.getByRole('button', { name: 'Stop sharing' }).click();
  await expect(panel.getByRole('button', { name: 'Share my wishlist' })).toBeVisible();
  await friend.reload();
  await expect(friend.getByText('This wishlist link has been switched off or never existed')).toBeVisible();
});
