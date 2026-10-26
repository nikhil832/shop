import { test, expect } from '@playwright/test';

// Named to run after catalog.spec.js: it adds a product (and sells the only one).
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ADDRESS = {
  name: 'Kabir Shah',
  phone: '9123456780',
  line1: '12 Hill Road',
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411001',
};

test('buy again puts what can still be bought back in the cart, and says what it left out', async ({
  page,
  browser,
}) => {
  // The admin adds a one-off product, so the customer can buy the last one.
  const admin = (await browser.newPage()).request;
  expect((await admin.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await admin.get('/api/categories')).json();
  const title = `Last One Vase ${unique()}`;
  const vase = await (
    await admin.post('/api/admin/products', {
      data: { title, brand: 'Griha', categoryId: category.id, price: 50000, mrp: 60000, stock: 1 },
    })
  ).json();

  // The customer orders two copies of a high-stock book and the vase (Cash on Delivery).
  const api = page.request;
  await api.post('/api/auth/register', {
    data: { name: 'Kabir Shah', email: `again-${unique()}@example.com`, password: 'password123' },
  });
  const { items } = await (await api.get('/api/products?q=quiet%20engineer')).json();
  const book = items[0];
  const lines = [
    { productId: book.id, qty: 2 },
    { productId: vase.id, qty: 1 },
  ];
  const quote = await (await api.get(`/api/cart?items=${book.id}:2,${vase.id}:1`)).json();
  const order = await (
    await api.post('/api/orders', { data: { items: lines, address: ADDRESS, expectedTotal: quote.total } })
  ).json();
  expect(order.status).toBe('placed');

  await page.goto(`/orders/${order.id}`);
  await page.getByRole('button', { name: 'Buy again' }).click();

  await expect(page).toHaveURL('/cart');
  await expect(page.getByRole('status')).toHaveText(
    `Added 1 item from order #${order.number} at today’s prices.Not added: ${title} (out of stock).`,
  );
  await expect(page.getByRole('heading', { name: 'Cart (2)' })).toBeVisible();
  await expect(page.getByLabel('Quantity of The Quiet Engineer (Paperback)')).toHaveValue('2');

  // Again, with the book already in the cart: its quantity stays, nothing is added twice.
  await page.goto(`/orders/${order.id}`);
  await page.getByRole('button', { name: 'Buy again' }).click();
  await expect(page.getByRole('heading', { name: 'Cart (2)' })).toBeVisible();
});

test('buy again with nothing left to buy says so on the order page', async ({ page, browser }) => {
  const admin = (await browser.newPage()).request;
  expect((await admin.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await admin.get('/api/categories')).json();
  const title = `Hidden Clock ${unique()}`;
  const clock = await (
    await admin.post('/api/admin/products', {
      data: { title, brand: 'Griha', categoryId: category.id, price: 60000, mrp: 60000, stock: 5 },
    })
  ).json();

  const api = page.request;
  await api.post('/api/auth/register', {
    data: { name: 'Kabir Shah', email: `again-${unique()}@example.com`, password: 'password123' },
  });
  const quote = await (await api.get(`/api/cart?items=${clock.id}:1`)).json();
  const order = await (
    await api.post('/api/orders', {
      data: { items: [{ productId: clock.id, qty: 1 }], address: ADDRESS, expectedTotal: quote.total },
    })
  ).json();
  // Hidden by the admin since: no longer sold.
  expect((await admin.patch(`/api/admin/products/${clock.id}`, { data: { active: false } })).ok()).toBe(true);

  await page.goto(`/orders/${order.id}`);
  await page.getByRole('button', { name: 'Buy again' }).click();
  await expect(page.getByRole('alert')).toHaveText(`None of these items can be added now: ${title} (no longer sold).`);
  await expect(page).toHaveURL(`/orders/${order.id}`);
});
