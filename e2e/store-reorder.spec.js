import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const ADDRESS = {
  name: 'Asha Rao',
  phone: '9123456780',
  line1: '12 Hill Road',
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411001',
};

test('the dashboard says what runs out soon at its recent sales and how many to order', async ({ page, browser }) => {
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await page.request.get('/api/categories')).json();
  const title = `Copper Bottle ${Date.now().toString(36)}`;
  const bottle = await (
    await page.request.post('/api/admin/products', {
      data: { title, brand: 'Griha', categoryId: category.id, price: 59900, mrp: 79900, stock: 8 },
    })
  ).json();

  // A customer buys 6 of 8: a new product, so judged on a week: about 0.9 a day, 2 left → 2 days.
  const customer = (await browser.newContext()).request;
  await customer.post('/api/auth/register', {
    data: { name: 'Asha Rao', email: `reorder-${Date.now()}@example.com`, password: 'password123' },
  });
  const quote = await (await customer.get(`/api/cart?items=${bottle.id}:6`)).json();
  expect(
    (
      await customer.post('/api/orders', {
        data: { items: [{ productId: bottle.id, qty: 6 }], address: ADDRESS, expectedTotal: quote.total },
      })
    ).ok(),
  ).toBe(true);

  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Running out soon' })).toBeVisible();
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: title }) })
    .last();
  await expect(row).toContainText('6 sold in 7 days, about 0.9 a day');
  await expect(row.getByRole('cell').nth(1)).toHaveText('2'); // left
  await expect(row.getByRole('cell').nth(2)).toHaveText('2'); // days
  await expect(row.getByRole('cell').nth(3)).toHaveText('24'); // order for a month: 6 / 7 × 30 − 2, rounded up
  await row.getByRole('link', { name: title }).click();
  await expect(page.getByRole('heading', { name: `Stock history: ${title}` })).toBeVisible();
});
