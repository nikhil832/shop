import { test, expect } from '@playwright/test';

// The demo never sends email, so the API tests cover the reminder itself; this checks its link and the switch.
const PRODUCT = '/p/the-quiet-engineer-paperback';

test('the email’s link opens the reviews, and logging in comes back to them', async ({ page }) => {
  const related = (await (await page.request.get('/api/products/the-quiet-engineer-paperback/related')).json()).items;
  // Rows above the reviews that arrive late must not push them out of view.
  await page.route(/\/api\/products\/[^/]+\/(bought-together|related)$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({ json: { items: related } });
  });
  await page.goto(`${PRODUCT}#reviews`);
  await expect(page.getByRole('region', { name: 'Frequently bought together' })).toBeAttached();
  await expect(page.getByRole('region', { name: 'Similar products' })).toBeAttached();
  const reviews = page.getByRole('region', { name: 'Ratings & reviews' });
  await expect(reviews).toBeInViewport();
  await expect(reviews.getByRole('link', { name: 'Log in' })).toHaveAttribute(
    'href',
    `/login?next=${encodeURIComponent(`${PRODUCT}#reviews`)}`,
  );
});

test('the account page switches review requests off and on', async ({ page }) => {
  const email = `review-ask-${Date.now()}@example.com`;
  await page.request.post('/api/auth/register', { data: { name: 'Leela Nair', email, password: 'password123' } });
  await page.goto('/account');
  const box = page.getByRole('checkbox', { name: 'Ask me once for reviews a few days after an order arrives' });
  await expect(box).toBeChecked();
  await box.click();
  await expect(page.getByRole('region', { name: 'Email updates' }).getByRole('status')).toHaveText(
    'Review requests are off.',
  );
  await page.reload();
  await expect(box).not.toBeChecked();
  await box.click();
  await expect(box).toBeChecked();
});
