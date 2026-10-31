import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

test('a customer says why they cancel, and the dashboard shows it', async ({ page, browser }) => {
  const email = `cancel-${Date.now()}@example.com`;
  await page.request.post('/api/auth/register', { data: { name: 'Ravi Kumar', email, password: 'password123' } });
  const book = await (await page.request.get('/api/products/the-quiet-engineer-paperback')).json();
  const quote = await (await page.request.get(`/api/cart?items=${book.id}:1`)).json();
  const order = await (
    await page.request.post('/api/orders', {
      data: {
        items: [{ productId: book.id, qty: 1 }],
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
    })
  ).json();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/orders/${order.id}`);
  await page.getByRole('button', { name: 'Cancel order' }).click();
  const form = page.getByRole('form', { name: 'Cancel this order' });
  await expect(form.getByRole('group', { name: 'Why are you cancelling?' })).toBeVisible();
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(
    (await new AxeBuilder({ page }).include('.cancel-order').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);

  // A reason is needed; "Keep my order" leaves it as it was.
  await form.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(form.getByRole('alert')).toHaveText('Choose a reason first.');
  await form.getByRole('button', { name: 'Keep my order' }).click();
  await expect(form).toHaveCount(0);
  await expect(page.locator('.order-head .status')).toHaveText('Placed');

  const note = `Found a signed copy ${Date.now().toString(36)}`;
  await page.getByRole('button', { name: 'Cancel order' }).click();
  await page.getByRole('radio', { name: 'Need a different address or details' }).check();
  await expect(page.getByText('You can also change the delivery address')).toBeVisible();
  await page.getByRole('radio', { name: 'Something else' }).check();
  await page.getByLabel('Anything we could do better? (optional)').fill(note);
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.locator('.order-head .status')).toHaveText('Cancelled');

  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await admin.goto('/admin');
  const panel = admin.getByRole('region', { name: 'Why customers cancelled' });
  await expect(panel.getByRole('listitem').filter({ hasText: 'Something else' })).toBeVisible();
  const said = panel.getByRole('listitem').filter({ hasText: note });
  await said.getByRole('link', { name: `Order #${order.number}` }).click();
  await expect(admin.getByText(`Cancelled by customer: Something else (“${note}”)`)).toBeVisible();
});
