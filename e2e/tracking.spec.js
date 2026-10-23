import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test('the admin ships with a courier and tracking link; the customer sees them on the order', async ({
  page,
  browser,
}) => {
  // The customer, in a browser of their own, orders a high-stock book through the API.
  const customer = await browser.newPage();
  const api = customer.request;
  expect(
    (
      await api.post('/api/auth/register', {
        data: { name: 'Meera Iyer', email: `track-${unique()}@example.com`, password: 'password123' },
      })
    ).ok(),
  ).toBe(true);
  const { items } = await (await api.get('/api/products?q=quiet%20engineer')).json();
  const quote = await (await api.get(`/api/cart?items=${items[0].id}:1`)).json();
  const order = await (
    await api.post('/api/orders', {
      data: {
        items: [{ productId: items[0].id, qty: 1 }],
        address: {
          name: 'Meera Iyer',
          phone: '9123456780',
          line1: '4 Park Street',
          city: 'Kolkata',
          state: 'West Bengal',
          pincode: '700016',
        },
        expectedTotal: quote.total,
      },
    })
  ).json();

  await page.goto(`/login?next=${encodeURIComponent(`/admin/orders/${order.id}`)}`);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  const form = page.getByRole('form', { name: 'Tracking' });
  await form.getByLabel('Courier', { exact: true }).fill('Delhivery');
  await form.getByLabel('Tracking number').fill('DLV1234');
  await form.getByLabel(/Tracking link/).fill('ftp://not-a-web-link');
  await form.getByRole('button', { name: 'Mark as shipped' }).click();
  // The browser accepts any URL scheme there; the server takes only web links.
  await expect(page.getByRole('alert')).toContainText('Paste a link starting with https://');
  await expect(page.locator('.order-head .status')).toHaveText('Placed');
  await form.getByLabel(/Tracking link/).fill('https://tracking.example.com/DLV1234');
  await form.getByRole('button', { name: 'Mark as shipped' }).click();
  await expect(page.locator('.order-head .status')).toHaveText('Shipped');
  await expect(page.getByText('Shipped with Delhivery · Tracking number DLV1234')).toBeVisible();

  // A correction later.
  await page.getByRole('button', { name: 'Edit tracking' }).click();
  await page.getByRole('form', { name: 'Tracking' }).getByLabel('Tracking number').fill('DLV12345');
  await page.getByRole('button', { name: 'Save tracking' }).click();
  await expect(page.getByText('Tracking number DLV12345')).toBeVisible();

  await customer.goto(`/orders/${order.id}`);
  const tracking = customer.getByRole('region', { name: 'Tracking' });
  await expect(tracking).toContainText('Shipped with Delhivery · Tracking number DLV12345');
  await expect(tracking.getByRole('link', { name: 'Track your parcel ↗' })).toHaveAttribute(
    'href',
    'https://tracking.example.com/DLV1234',
  );
  await customer.close();
});
