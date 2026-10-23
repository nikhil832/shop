import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test('a customer returns one of two books; the admin approves it and marks the COD refund paid', async ({
  page,
  browser,
}) => {
  // The admin, in a browser of their own, moves the order along through the API.
  const adminPage = await browser.newPage();
  expect((await adminPage.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);

  // The customer orders two copies of a high-stock book (Cash on Delivery).
  const api = page.request;
  expect(
    (
      await api.post('/api/auth/register', {
        data: { name: 'Meera Iyer', email: `returns-${unique()}@example.com`, password: 'password123' },
      })
    ).ok(),
  ).toBe(true);
  const { items } = await (await api.get('/api/products?q=quiet%20engineer')).json();
  const quote = await (await api.get(`/api/cart?items=${items[0].id}:2`)).json();
  const order = await (
    await api.post('/api/orders', {
      data: {
        items: [{ productId: items[0].id, qty: 2 }],
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
  for (const status of ['shipped', 'delivered']) {
    expect((await adminPage.request.post(`/api/admin/orders/${order.id}/status`, { data: { status } })).ok()).toBe(
      true,
    );
  }

  await page.goto(`/orders/${order.id}`);
  await page.getByRole('region', { name: 'Returns' }).getByRole('link', { name: 'Return items' }).click();
  await expect(page.getByRole('heading', { name: 'Return items' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask to return' })).toBeDisabled();
  await page.getByLabel('How many of The Quiet Engineer (Paperback) to return').selectOption('1');
  await expect(page.getByText('Items chosen: ₹349')).toBeVisible();
  await page.getByLabel('Reason').selectOption({ label: 'Arrived damaged or faulty' });
  await page.getByLabel(/Anything we should know/).fill('Cover torn');
  await page.getByRole('button', { name: 'Ask to return' }).click();

  await expect(page).toHaveURL(`/orders/${order.id}`);
  await expect(page.getByRole('status').first()).toContainText('Return requested');
  const returns = page.getByRole('region', { name: 'Returns' });
  await expect(returns).toContainText('The Quiet Engineer (Paperback) × 1');
  await expect(returns).toContainText('Waiting for review');
  // The other copy can still be returned.
  await expect(returns.getByRole('link', { name: 'Return items' })).toBeVisible();

  // The admin reviews it in the Returns tab.
  await adminPage.goto('/admin/returns');
  const row = adminPage.getByRole('row', { name: new RegExp(`#${order.number}`) });
  await expect(row).toContainText('Arrived damaged or faulty: Cover torn');
  await expect(row).toContainText('₹349');
  adminPage.once('dialog', (d) => d.accept());
  await row.getByRole('button', { name: /^Approve/ }).click();
  await expect(row).toHaveCount(0); // no longer waiting for review
  await adminPage.getByRole('button', { name: /^Refund to pay/ }).click();
  const toPay = adminPage.getByRole('row', { name: new RegExp(`#${order.number}`) });
  await expect(toPay).toContainText('Approved · refund to pay');
  await toPay.getByRole('button', { name: /^Mark refunded/ }).click();
  await adminPage.getByRole('button', { name: /^Refunded/ }).click();
  await expect(adminPage.getByRole('row', { name: new RegExp(`#${order.number}`) })).toContainText('Refunded');
  // The dashboard's revenue is now net of it.
  await adminPage.goto('/admin');
  await expect(adminPage.getByRole('region', { name: 'Totals' })).toContainText(/in sales − ₹[\d,]+ refunded/);
  await adminPage.close();

  await page.reload();
  await expect(page.getByRole('region', { name: 'Returns' })).toContainText('Refunded');
});
