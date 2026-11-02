import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const ADDRESS = {
  name: 'Meera Iyer',
  phone: '9123456781',
  line1: '4 Lake View',
  city: 'Chennai',
  state: 'Tamil Nadu',
  pincode: '600001',
};

test('customers confirm Cash on Delivery orders, and staff mark them confirmed by phone', async ({ page, browser }) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  try {
    // Switched on from the COD rules on Admin → Delivery.
    await admin.goto('/admin/delivery');
    const rules = admin.getByRole('form', { name: 'Cash on Delivery' });
    await rules.getByLabel('Ask customers to confirm Cash on Delivery orders').check();
    await rules.getByRole('button', { name: 'Save' }).click();
    await expect(rules.getByRole('status')).toHaveText('Saved.');

    const stamp = Date.now().toString(36);
    await page.request.post('/api/auth/register', {
      data: { name: `Meera ${stamp}`, email: `cod-confirm-${stamp}@example.com`, password: 'password123' },
    });
    const { items } = await (await page.request.get('/api/products?q=quiet%20engineer')).json();
    const book = items[0];
    const order = async () => {
      const quote = await (await page.request.get(`/api/cart?items=${book.id}:1`)).json();
      const res = await page.request.post('/api/orders', {
        data: { items: [{ productId: book.id, qty: 1 }], address: ADDRESS, expectedTotal: quote.total },
      });
      expect(res.status()).toBe(201);
      return res.json();
    };

    // The customer confirms on the order page.
    const first = await order();
    await page.goto(`/orders/${first.id}`);
    const box = page.getByRole('region', { name: 'Confirm your order' });
    await expect(box).toContainText(/Please confirm you'll pay ₹\d+ in cash on delivery/);
    expect(
      (await new AxeBuilder({ page }).include('.confirm-cod').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    ).toEqual([]);
    await box.getByRole('button', { name: 'Yes, ship it' }).click();
    await expect(box).toContainText('Thank you! Your order is confirmed');
    await page.reload();
    await expect(page.getByRole('heading', { name: /^Order #/ })).toBeVisible();
    await expect(box).toHaveCount(0);
    await admin.goto(`/admin/orders/${first.id}`);
    await expect(admin.getByText('Confirmed by customer')).toBeVisible();

    // Another one, confirmed by phone from the admin page.
    const second = await order();
    await admin.goto(`/admin/orders/${second.id}`);
    await expect(admin.getByText('Cash on Delivery not confirmed yet.')).toBeVisible();
    await admin.getByRole('button', { name: 'Confirmed by phone' }).click();
    await expect(admin.getByText(/^Confirmed by phone \(/)).toBeVisible();
    await expect(admin.getByText('Cash on Delivery not confirmed yet.')).toHaveCount(0);
    await page.goto(`/orders/${second.id}`);
    await expect(page.getByRole('heading', { name: /^Order #/ })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Confirm your order' })).toHaveCount(0);

    // The email's link page, with a token that matches nothing (the demo sends no email).
    await page.goto('/confirm-order#token=abcdefghijklmnopqrstuvwx');
    await page.getByRole('button', { name: 'Yes, ship it' }).click();
    await expect(page.getByRole('alert')).toHaveText("This link doesn't match an order. It may have been mistyped.");
  } finally {
    // Every spec shares this server: other COD orders shouldn't ask to be confirmed.
    const res = await admin.request.put('/api/admin/cod', {
      data: { maxOrder: null, refusedLimit: 2, confirm: false },
    });
    expect(res.ok()).toBe(true);
  }
});
