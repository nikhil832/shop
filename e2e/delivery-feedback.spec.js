import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

test('a customer says how the delivery went, and the courier report shows it', async ({ page, browser }) => {
  const email = `delivery-${Date.now()}@example.com`;
  await page.request.post('/api/auth/register', { data: { name: 'Kavya Nair', email, password: 'password123' } });
  const book = await (await page.request.get('/api/products/the-quiet-engineer-paperback')).json();
  const quote = await (await page.request.get(`/api/cart?items=${book.id}:1`)).json();
  const order = await (
    await page.request.post('/api/orders', {
      data: {
        items: [{ productId: book.id, qty: 1 }],
        address: {
          name: 'Kavya Nair',
          phone: '9123456780',
          line1: '1 Lake Road',
          city: 'Pune',
          state: 'Maharashtra',
          pincode: '411001',
        },
        expectedTotal: quote.total,
      },
    })
  ).json();
  // A courier of its own, as every spec shares the server's orders.
  const courier = `Swift ${Date.now().toString(36)}`;
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const status = (data) => admin.request.post(`/api/admin/orders/${order.id}/status`, { data });
  expect((await status({ status: 'shipped', shipment: { courier } })).ok()).toBe(true);
  expect((await status({ status: 'delivered' })).ok()).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/orders/${order.id}`);
  const panel = page.getByRole('region', { name: 'How was your delivery?' });
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByRole('alert')).toHaveText('Choose how the delivery went first.');
  expect(
    (await new AxeBuilder({ page }).include('.delivery-feedback').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  const note = `Box was wet ${Date.now().toString(36)}`;
  await panel.getByRole('radio', { name: 'The package was damaged' }).check();
  await panel.getByLabel('Anything to add? (optional)').fill(note);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel).toContainText('Thanks for telling us: the package was damaged.');
  await expect(panel).toContainText(note);

  // Changing the answer keeps the form filled in with the last one.
  await panel.getByRole('button', { name: 'Change my answer' }).click();
  await expect(panel.getByRole('radio', { name: 'The package was damaged' })).toBeChecked();
  await panel.getByRole('button', { name: 'Keep my answer' }).click();
  await expect(panel).toContainText('Thanks for telling us');

  await admin.goto('/admin/delivery');
  await admin.getByRole('link', { name: 'Courier report' }).click();
  await expect(admin.getByRole('heading', { name: 'Courier report' })).toBeVisible();
  const row = admin.getByRole('row').filter({ hasText: courier });
  await expect(row.getByRole('cell')).toHaveText([courier, '1', /^0/, '1', '0%', '0%', '100%']);
  const said = admin
    .getByRole('region', { name: 'What customers said' })
    .getByRole('listitem')
    .filter({ hasText: note });
  await said.getByRole('link', { name: `Order #${order.number}` }).click();
  await expect(admin.getByText(`Customer said: the package was damaged (“${note}”)`)).toBeVisible();
});
