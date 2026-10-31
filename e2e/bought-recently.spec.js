import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// Its own product (hidden again at the end), bought by five new customers.
test('a product bought by five people this week says so', async ({ page, playwright, baseURL }) => {
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await page.request.get('/api/categories')).json();
  const title = `Kitwell Bottle ${Date.now().toString(36)}`;
  const made = await page.request.post('/api/admin/products', {
    data: { title, brand: 'Kitwell', categoryId: category.id, price: 49900, mrp: 59900, stock: 20 },
  });
  expect(made.status()).toBe(201);
  const product = await made.json();
  try {
    const buy = async (n) => {
      const customer = await playwright.request.newContext({ baseURL });
      const email = `bought-${n}-${Date.now()}@example.com`;
      await customer.post('/api/auth/register', { data: { name: 'Ravi Kumar', email, password: 'password123' } });
      const quote = await (await customer.get(`/api/cart?items=${product.id}:1`)).json();
      const res = await customer.post('/api/orders', {
        data: {
          items: [{ productId: product.id, qty: 1 }],
          address: {
            name: 'Ravi Kumar',
            phone: '9123456780',
            line1: '1 Lake Road',
            city: 'Pune',
            state: 'Maharashtra',
            pincode: '411001',
          },
          expectedTotal: quote.total,
        },
      });
      expect(res.status()).toBe(201);
      await customer.dispose();
    };

    for (let n = 1; n <= 4; n++) await buy(n);
    await page.goto(`/p/${product.slug}`);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByText(/people bought this/)).toHaveCount(0);

    await buy(5);
    await page.reload();
    await expect(page.getByText('5 people bought this in the last 7 days')).toBeVisible();
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      expect(
        (await new AxeBuilder({ page }).include('.bought-recently').withTags(['wcag2a', 'wcag2aa']).analyze())
          .violations,
      ).toEqual([]);
    }
  } finally {
    await page.request.patch(`/api/admin/products/${product.id}`, { data: { active: false } });
  }
});
