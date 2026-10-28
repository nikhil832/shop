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

// The only spec that gives products a cost price, so the dashboard's profit is this product's.
test('an admin enters a cost price and the dashboard shows the profit and margin', async ({ page, browser }) => {
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await page.request.get('/api/categories')).json();
  const title = `Clay Planter ${Date.now().toString(36)}`;
  const planter = await (
    await page.request.post('/api/admin/products', {
      data: { title, brand: 'Mitti', categoryId: category.id, price: 40000, mrp: 50000, stock: 50 },
    })
  ).json();

  await page.goto(`/admin/products/${planter.id}`);
  await page.getByRole('spinbutton', { name: /^Cost/ }).fill('250');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL('/admin/products');

  // A customer buys 4 at ₹400 (cost ₹250): ₹600 profit on ₹1,600, 37.5%.
  const customer = (await browser.newContext()).request;
  await customer.post('/api/auth/register', {
    data: { name: 'Asha Rao', email: `profit-${Date.now()}@example.com`, password: 'password123' },
  });
  const quote = await (await customer.get(`/api/cart?items=${planter.id}:4`)).json();
  expect(
    (
      await customer.post('/api/orders', {
        data: { items: [{ productId: planter.id, qty: 4 }], address: ADDRESS, expectedTotal: quote.total },
      })
    ).ok(),
  ).toBe(true);
  // The customer's own order never shows the cost.
  const [order] = await (await customer.get('/api/orders')).json();
  expect(JSON.stringify(order)).not.toContain('"cost"');

  await page.goto('/admin');
  const card = page.locator('.stat').filter({ has: page.getByRole('heading', { name: 'Profit' }) });
  await expect(card).toContainText('₹600');
  await expect(card).toContainText('37.5% margin');
});
