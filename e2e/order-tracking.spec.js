import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('anyone tracks an order with its number and PIN code, from the footer', async ({ page, browser }) => {
  // A customer orders a book (their own browser).
  const buyer = await (await browser.newContext()).newPage();
  await buyer.request.post('/api/auth/register', {
    data: { name: 'Asha Rao', email: `track-${Date.now()}@example.com`, password: 'password123' },
  });
  const book = await (await buyer.request.get('/api/products/the-quiet-engineer-paperback')).json();
  const quote = await (await buyer.request.get(`/api/cart?items=${book.id}:1`)).json();
  const order = await (
    await buyer.request.post('/api/orders', {
      data: {
        items: [{ productId: book.id, qty: 1 }],
        address: {
          name: 'Ravi Kumar',
          phone: '9876543210',
          line1: '12 MG Road',
          city: 'Bengaluru',
          state: 'Karnataka',
          pincode: '560001',
        },
        expectedTotal: quote.total,
      },
    })
  ).json();

  // Someone else, not logged in, from the footer.
  await page.goto('/');
  await page.getByRole('contentinfo').getByRole('link', { name: 'Track an order' }).click();
  await expect(page).toHaveURL('/track');
  await page.getByLabel('Order number').fill(`#${order.number}`);
  await page.getByLabel('Delivery PIN code').fill('560002');
  await page.getByRole('button', { name: 'Track' }).click();
  await expect(page.getByRole('alert')).toHaveText("We couldn't find an order with that number and PIN code.");

  await page.getByLabel('Delivery PIN code').fill('560001');
  await page.getByRole('button', { name: 'Track' }).click();
  const result = page.getByRole('region', { name: `Order #${order.number}` });
  await expect(result).toBeVisible();
  await expect(result.getByRole('list', { name: 'Order progress' })).toContainText('Ordered');
  await expect(result).toContainText('The Quiet Engineer (Paperback) × 1');
  await expect(result).not.toContainText('Ravi');
  await expect(result).not.toContainText('₹');
  expect(
    (await new AxeBuilder({ page }).include('.track-page').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
});
