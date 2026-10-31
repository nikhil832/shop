import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const address = {
  name: 'Meera Iyer',
  phone: '9123456780',
  line1: '4 Park Street',
  city: 'Kolkata',
  state: 'West Bengal',
  pincode: '700016',
};

// A COD order placed through the API with the page's own cookies, so the page is logged in as its customer.
async function placeOrder(page) {
  const email = `invoice-${unique()}@example.com`;
  const api = page.request;
  expect(
    (await api.post('/api/auth/register', { data: { name: 'Meera Iyer', email, password: 'password123' } })).ok(),
  ).toBe(true);
  const { items } = await (await api.get('/api/products?q=quiet%20engineer')).json();
  const quote = await (await api.get(`/api/cart?items=${items[0].id}:2`)).json();
  const res = await api.post('/api/orders', {
    data: { items: [{ productId: items[0].id, qty: 2 }], address, expectedTotal: quote.total },
  });
  expect(res.status()).toBe(201);
  return { email, order: await res.json() };
}

test('a customer opens a printable invoice from their order', async ({ page }) => {
  const { email, order } = await placeOrder(page);
  await page.goto(`/orders/${order.id}`);
  await page.getByRole('link', { name: 'Invoice' }).click();
  await expect(page).toHaveURL(`/orders/${order.id}/invoice`);

  const invoice = page.getByRole('article', { name: 'Invoice' });
  await expect(invoice).toContainText(`#${order.number}`);
  await expect(invoice.getByRole('region', { name: 'Billed to' })).toContainText('4 Park Street');
  await expect(invoice.getByRole('region', { name: 'Billed to' })).toContainText(email);
  await expect(invoice.getByRole('row', { name: /The Quiet Engineer/ })).toContainText('2');
  const total = `₹${(order.total / 100).toLocaleString('en-IN')}`;
  await expect(invoice.getByRole('row', { name: /^Total/ })).toContainText(total);
  await expect(invoice).toContainText(`Cash on Delivery: ${total} to pay on delivery`);

  // Printed, only the invoice shows: no store header or buttons.
  await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('banner')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeHidden();
  await expect(invoice).toBeVisible();
  await page.emulateMedia({ media: 'screen' });

  // A cancelled order has no invoice.
  await page.goto(`/orders/${order.id}`);
  await page.getByRole('button', { name: 'Cancel order' }).click();
  await page.getByRole('radio', { name: 'Ordered by mistake' }).check();
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.locator('.order-head .status')).toHaveText('Cancelled');
  await expect(page.getByRole('link', { name: 'Invoice' })).toHaveCount(0);
  await page.goto(`/orders/${order.id}/invoice`);
  await expect(page.getByRole('heading', { name: 'No invoice for this order' })).toBeVisible();
});

test("an admin opens an order's invoice, with the customer's email", async ({ page, browser }) => {
  // The customer orders in a separate browser, so this page can log in as the admin.
  const customer = await browser.newPage();
  const { email, order } = await placeOrder(customer);
  await customer.close();

  await page.goto(`/login?next=${encodeURIComponent(`/admin/orders/${order.id}`)}`);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('link', { name: 'Invoice' }).click();
  await expect(page).toHaveURL(`/admin/orders/${order.id}/invoice`);
  const invoice = page.getByRole('article', { name: 'Invoice' });
  await expect(invoice).toContainText(`#${order.number}`);
  await expect(invoice).toContainText(email);
  await page.getByRole('link', { name: `Back to order #${order.number}` }).click();
  await expect(page).toHaveURL(`/admin/orders/${order.id}`);
});
