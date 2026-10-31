import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// Its own product (hidden again at the end), since every spec shares the server's orders.
test('admins see which products come back and why', async ({ page, browser }) => {
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await page.request.get('/api/categories')).json();
  const title = `Kitwell Mug ${Date.now().toString(36)}`;
  const made = await page.request.post('/api/admin/products', {
    data: { title, brand: 'Kitwell', categoryId: category.id, price: 29900, mrp: 39900, stock: 20 },
  });
  expect(made.status()).toBe(201);
  const product = await made.json();
  try {
    const customer = await (await browser.newContext()).newPage();
    const email = `returns-${Date.now()}@example.com`;
    await customer.request.post('/api/auth/register', { data: { name: 'Isha Menon', email, password: 'password123' } });
    const quote = await (await customer.request.get(`/api/cart?items=${product.id}:4`)).json();
    const order = await (
      await customer.request.post('/api/orders', {
        data: {
          items: [{ productId: product.id, qty: 4 }],
          address: {
            name: 'Isha Menon',
            phone: '9123456780',
            line1: '7 Beach Road',
            city: 'Kochi',
            state: 'Kerala',
            pincode: '682001',
          },
          expectedTotal: quote.total,
        },
      })
    ).json();
    for (const status of ['shipped', 'delivered']) {
      expect((await page.request.post(`/api/admin/orders/${order.id}/status`, { data: { status } })).ok()).toBe(true);
    }
    const note = `Handle cracked ${Date.now().toString(36)}`;
    const asked = await customer.request.post(`/api/orders/${order.id}/returns`, {
      data: { items: [{ index: 0, qty: 1 }], reason: 'damaged', note },
    });
    expect(asked.status()).toBe(201);

    await page.goto('/admin/returns');
    await page.getByRole('link', { name: 'Return reasons' }).click();
    await expect(page.getByRole('heading', { name: 'Return reasons', level: 1 })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: title });
    await expect(row.getByRole('cell')).toHaveText([title, '4', '1', '0', '25%', 'Arrived damaged or faulty (1)']);
    await expect(
      page.getByRole('region', { name: 'What customers said' }).getByRole('listitem').filter({ hasText: note }),
    ).toContainText(`Order #${order.number}`);
  } finally {
    await page.request.patch(`/api/admin/products/${product.id}`, { data: { active: false } });
  }
});
