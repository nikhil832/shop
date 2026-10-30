import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

test('a customer cancels one of three books before shipping, then the admin cancels another', async ({
  page,
  browser,
}) => {
  const stamp = Date.now().toString(36);
  expect(
    (
      await page.request.post('/api/auth/register', {
        data: { name: 'Rohan Das', email: `fewer-${stamp}@example.com`, password: 'password123' },
      })
    ).ok(),
  ).toBe(true);
  const book = await (await page.request.get('/api/products/the-quiet-engineer-paperback')).json();
  const quote = await (await page.request.get(`/api/cart?items=${book.id}:3`)).json();
  const order = await (
    await page.request.post('/api/orders', {
      data: {
        items: [{ productId: book.id, qty: 3 }],
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
  expect(order.total).toBe(104700); // ₹1,047, free delivery

  await page.goto(`/orders/${order.id}`);
  await page.getByRole('button', { name: 'Cancel some items' }).click();
  const form = page.getByRole('form', { name: 'Cancel some items' });
  await form.getByRole('combobox', { name: /The Quiet Engineer/ }).selectOption('1');
  await form.getByRole('button', { name: 'Check the new total' }).click();
  await expect(form.getByRole('status')).toHaveText('The total becomes ₹698 (₹349 less). ₹698 is paid on delivery.');
  expect(
    (await new AxeBuilder({ page }).include('.cancel-items').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await form.getByRole('button', { name: 'Cancel these items' }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByText('₹349 × 2')).toBeVisible();
  const cancelled = page.locator('.cancelled-items');
  await expect(cancelled).toContainText('The Quiet Engineer (Paperback) × 1');
  await expect(cancelled).toContainText('by you · ₹349 off the total');

  // The admin sees who did it, and cancels one more.
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await admin.goto(`/admin/orders/${order.id}`);
  await expect(admin.locator('.cancelled-items')).toContainText('by the customer');
  await admin.getByRole('button', { name: 'Cancel some items' }).click();
  const adminForm = admin.getByRole('form', { name: 'Cancel some items' });
  await adminForm.getByRole('combobox', { name: /The Quiet Engineer/ }).selectOption('1');
  await adminForm.getByRole('button', { name: 'Check the new total' }).click();
  await adminForm.getByRole('button', { name: 'Cancel these items' }).click();
  await expect(admin.locator('.cancelled-items li')).toHaveCount(2);
  await expect(admin.locator('.cancelled-items')).toContainText('by Demo Admin');
  // One book left: nothing more to cancel here but the whole order.
  await expect(admin.getByRole('button', { name: 'Cancel some items' })).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.cancelled-items')).toContainText('by the store');
  await expect(page.getByRole('button', { name: 'Cancel some items' })).toHaveCount(0);
});
