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

test('an admin makes someone a packer, who sees only orders and can ship but not cancel', async ({ page, browser }) => {
  const stamp = Date.now().toString(36);
  const packerEmail = `packer-${stamp}@example.com`;

  // A customer's order to ship, and the future packer's own account.
  const customer = (await browser.newContext()).request;
  await customer.post('/api/auth/register', {
    data: { name: 'Asha Rao', email: `staffbuy-${stamp}@example.com`, password: 'password123' },
  });
  const { items } = await (await customer.get('/api/products?q=quiet%20engineer')).json();
  const quote = await (await customer.get(`/api/cart?items=${items[0].id}:1`)).json();
  const order = await (
    await customer.post('/api/orders', {
      data: { items: [{ productId: items[0].id, qty: 1 }], address: ADDRESS, expectedTotal: quote.total },
    })
  ).json();
  expect(
    (
      await page.request.post('/api/auth/register', {
        data: { name: 'Pooja Packer', email: packerEmail, password: 'password123' },
      })
    ).ok(),
  ).toBe(true);

  // The admin adds them on Admin → Staff.
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await admin.goto('/admin/staff');
  const form = admin.getByRole('form', { name: 'Add staff' });
  await form.getByLabel("Their account's email").fill(packerEmail);
  await form.getByLabel('Role').selectOption('packer');
  await form.getByRole('button', { name: 'Add staff' }).click();
  await expect(admin.getByRole('status')).toHaveText(`${packerEmail} is now Packer.`);
  await expect(admin.getByLabel('Role of Pooja Packer')).toHaveValue('packer');

  try {
    // The packer: an Admin link, landing on Orders, with only that tab.
    await page.goto('/');
    await page.getByRole('link', { name: 'Admin' }).click();
    await expect(page).toHaveURL('/admin/orders');
    const tabs = page.getByRole('navigation', { name: 'Admin' }).getByRole('link');
    await expect(tabs).toHaveText(['Orders']);

    await page.goto(`/admin/orders/${order.id}`);
    await expect(page.getByRole('heading', { name: `Order #${order.number}` })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Mark as shipped' }).click();
    await expect(page.getByRole('button', { name: 'Mark as delivered' })).toBeVisible();

    // Admin pages beyond their role are refused by the server.
    const products = await page.request.get('/api/admin/products');
    expect(products.status()).toBe(403);
  } finally {
    await admin.goto('/admin/staff');
    await admin.getByLabel('Role of Pooja Packer').selectOption('user');
    await expect(admin.getByRole('status')).toHaveText('Pooja Packer is no longer staff.');
  }
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Admins only' })).toBeVisible();
});
