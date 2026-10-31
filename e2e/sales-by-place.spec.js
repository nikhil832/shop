import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// Other specs' orders are on the shared server too, so this checks its own state's row and the switch, and leaves
// exact sums to server/test/salesByPlace.test.js.
test('the dashboard shows sales by state and by city', async ({ page, browser }) => {
  const customer = await (await browser.newContext()).newPage();
  const email = `place-${Date.now()}@example.com`;
  await customer.request.post('/api/auth/register', { data: { name: 'Neha Das', email, password: 'password123' } });
  const book = await (await customer.request.get('/api/products/the-quiet-engineer-paperback')).json();
  const quote = await (await customer.request.get(`/api/cart?items=${book.id}:1`)).json();
  const placed = await customer.request.post('/api/orders', {
    data: {
      items: [{ productId: book.id, qty: 1 }],
      address: {
        name: 'Neha Das',
        phone: '9123456780',
        line1: '4 Aberdeen Bazaar',
        city: 'Port Blair',
        // The longest state name, which makes the table wider than a phone (a keyboard must be able to scroll it).
        state: 'Andaman and Nicobar Islands',
        pincode: '744101',
      },
      expectedTotal: quote.total,
    },
  });
  expect(placed.status()).toBe(201);

  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin');
  const panel = page.getByRole('region', { name: 'Sales by place' });
  await expect(panel.getByRole('button', { name: 'States' })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('row').filter({ hasText: 'Andaman and Nicobar Islands' })).toBeVisible();
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(
    (await new AxeBuilder({ page }).include('.sales-by-place').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);

  await expect(panel.getByRole('region', { name: 'Sales by state' })).toHaveAttribute('tabindex', '0');

  await panel.getByRole('button', { name: 'Top cities' }).click();
  await expect(panel.getByRole('button', { name: 'Top cities' })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('columnheader', { name: 'City' })).toBeVisible();
  await expect(panel.getByRole('row').nth(1)).toContainText('%');
});
