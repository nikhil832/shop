import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

test('a customer corrects the delivery address before it ships; the admin sees the earlier one and can change it too', async ({
  page,
  browser,
}) => {
  const stamp = Date.now().toString(36);
  expect(
    (
      await page.request.post('/api/auth/register', {
        data: { name: 'Rohan Das', email: `moving-${stamp}@example.com`, password: 'password123' },
      })
    ).ok(),
  ).toBe(true);
  const book = await (await page.request.get('/api/products/the-quiet-engineer-paperback')).json();
  const quote = await (await page.request.get(`/api/cart?items=${book.id}:1`)).json();
  const order = await (
    await page.request.post('/api/orders', {
      data: {
        items: [{ productId: book.id, qty: 1 }],
        address: {
          name: 'Rohan Das',
          phone: '9123456780',
          line1: '9 Old Lane',
          city: 'Pune',
          state: 'Maharashtra',
          pincode: '411001',
        },
        expectedTotal: quote.total,
      },
    })
  ).json();

  await page.goto(`/orders/${order.id}`);
  const panel = page.getByRole('region', { name: 'Delivery address' });
  await panel.getByRole('button', { name: 'Change address' }).click();
  const form = panel.getByRole('form', { name: 'New delivery address' });
  await expect(form.getByLabel('Address (house, street, area)')).toHaveValue('9 Old Lane');
  expect(
    (await new AxeBuilder({ page }).include('.change-address').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await form.getByLabel('Address (house, street, area)').fill('21 New Street');
  await form.getByLabel('Landmark (optional)').fill('Opposite the park');
  await form.getByRole('button', { name: 'Save address' }).click();
  await expect(form).toHaveCount(0);
  await expect(panel.locator('address')).toContainText('21 New Street');
  await expect(panel.locator('address')).toContainText('Opposite the park');
  await expect(panel).toContainText(/Changed on/);

  // The admin sees what it was, and changes the phone number for the customer.
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await admin.goto(`/admin/orders/${order.id}`);
  await admin.getByText('Address changed once').click();
  await expect(admin.getByText(/by Rohan Das \(customer\)\. Was: 9 Old Lane, Pune, Maharashtra 411001/)).toBeVisible();
  await admin.getByRole('button', { name: 'Change address' }).click();
  await admin.getByLabel('Mobile number').fill('9988776655');
  await admin.getByRole('button', { name: 'Save address' }).click();
  await expect(admin.getByText('Address changed 2 times')).toBeVisible();
  await expect(admin.locator('address')).toContainText('9988776655');

  // Once shipped, the customer can't change it any more.
  expect((await admin.request.post(`/api/admin/orders/${order.id}/status`, { data: { status: 'shipped' } })).ok()).toBe(
    true,
  );
  await page.reload();
  await expect(panel.locator('address')).toContainText('9988776655');
  await expect(panel.getByRole('button', { name: 'Change address' })).toHaveCount(0);
});
