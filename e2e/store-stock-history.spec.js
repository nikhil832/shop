import { test, expect } from '@playwright/test';

// Named to run after catalog.spec.js (files run alphabetically on one shared demo server): it adds a product.
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const ADDRESS = {
  name: 'Asha Rao',
  phone: '9123456780',
  line1: '12 Hill Road',
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411001',
};
const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test('an admin sees why stock changed: added, ordered, cancelled and changed by hand', async ({ page, browser }) => {
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await page.request.get('/api/categories')).json();
  const title = `Brass Diya ${unique()}`;
  const diya = await (
    await page.request.post('/api/admin/products', {
      data: { title, brand: 'Griha', categoryId: category.id, price: 29900, mrp: 39900, stock: 5 },
    })
  ).json();

  // A customer orders two, then cancels one order of one.
  const customer = (await browser.newContext()).request;
  await customer.post('/api/auth/register', {
    data: { name: 'Asha Rao', email: `stock-${unique()}@example.com`, password: 'password123' },
  });
  const place = async (qty) => {
    const quote = await (await customer.get(`/api/cart?items=${diya.id}:${qty}`)).json();
    const res = await customer.post('/api/orders', {
      data: { items: [{ productId: diya.id, qty }], address: ADDRESS, expectedTotal: quote.total },
    });
    expect(res.ok()).toBe(true);
    return res.json();
  };
  const kept = await place(2);
  const cancelled = await place(1);
  expect((await customer.post(`/api/orders/${cancelled.id}/cancel`)).ok()).toBe(true);

  // The admin counts the shelf and sets the stock to 10 in the product form.
  await page.goto(`/admin/products/${diya.id}`);
  await page.getByRole('spinbutton', { name: 'Stock' }).fill('10');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL('/admin/products');

  await page.goto(`/admin/products/${diya.id}`);
  await page.getByRole('link', { name: 'Stock history' }).click();
  await expect(page.getByRole('heading', { name: `Stock history: ${title}` })).toBeVisible();
  await expect(page.getByText('In stock now: 10')).toBeVisible();
  const rows = page.getByRole('row');
  await expect(rows).toHaveCount(6); // the heading row and five changes
  await expect(rows.nth(1)).toContainText('+7');
  await expect(rows.nth(1)).toContainText('Changed by hand · Demo Admin');
  await expect(rows.nth(2)).toContainText('Cancelled by the customer');
  await expect(rows.nth(2)).toContainText(`Order #${cancelled.number}`);
  await expect(rows.nth(3)).toContainText('−1');
  await expect(rows.nth(4)).toContainText(`Ordered · Order #${kept.number}`);
  await expect(rows.nth(4).getByRole('cell').nth(2)).toHaveText('3'); // 5 − 2, the stock after
  await expect(rows.nth(5)).toContainText('Product added');

  // The order link leads to the order.
  await rows
    .nth(4)
    .getByRole('link', { name: `Order #${kept.number}` })
    .click();
  await expect(page.getByRole('heading', { name: `Order #${kept.number}` })).toBeVisible();
  await page.getByRole('link', { name: `Stock history of ${title}` }).click();
  await expect(page.getByRole('heading', { name: `Stock history: ${title}` })).toBeVisible();
});
