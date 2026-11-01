import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const address = {
  name: 'Leela Das',
  phone: '9123456780',
  line1: '1 Lake Road',
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411001',
};

// Loyalty on the shared server would change every spec's delivery charge, so it's switched off again in `finally`.
test('an admin sets loyalty levels; a customer who reaches one sees it and gets cheaper delivery', async ({
  page,
  browser,
}) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  try {
    // Low spends, so one delivered order reaches Silver.
    await admin.goto('/admin/coupons');
    const form = admin.getByRole('form', { name: 'Loyalty levels' });
    await form.getByLabel('Give loyalty levels').check();
    await form.getByLabel('Silver from (₹ a year)').fill('100');
    await form.getByLabel('Silver: free delivery from (₹)').fill('299');
    await form.getByLabel('Gold from (₹ a year)').fill('100000');
    await form.getByLabel('Silver: extra cashback (%)').fill('1');
    await form.getByLabel('Gold: free delivery from (₹)').fill('0');
    await form.getByLabel('Gold: extra cashback (%)').fill('2');
    await form.getByRole('button', { name: 'Save loyalty levels' }).click();
    await expect(form.getByRole('status')).toHaveText('Saved.');

    // A customer buys once and it's delivered.
    await page.request.post('/api/auth/register', {
      data: { name: 'Leela Das', email: `loyal-${Date.now()}@example.com`, password: 'password123' },
    });
    const book = await (await page.request.get('/api/products/the-quiet-engineer-paperback')).json();
    const quote = await (await page.request.get(`/api/cart?items=${book.id}:1`)).json();
    expect(quote.delivery).toBe(4000);
    const order = await (
      await page.request.post('/api/orders', {
        data: { items: [{ productId: book.id, qty: 1 }], address, expectedTotal: quote.total },
      })
    ).json();
    for (const status of ['shipped', 'delivered']) {
      expect((await admin.request.post(`/api/admin/orders/${order.id}/status`, { data: { status } })).ok()).toBe(true);
    }

    await page.goto('/account');
    const level = page.getByRole('region', { name: 'Your level' });
    await expect(level).toContainText("You're Silver: free delivery from ₹299 and 1% extra cashback.");
    await expect(level).toContainText(/Spend ₹[\d,]+ more to reach Gold/);

    // The book (₹349) now has free delivery.
    await page.goto('/p/the-quiet-engineer-paperback');
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await page.goto('/cart');
    const summary = page.getByRole('complementary', { name: 'Order summary' });
    await expect(summary).toContainText('Silver member: free delivery from ₹299 and 1% extra cashback');
    // Silver's 1% of ₹349, with the store's cashback off.
    await expect(page.getByText("You'll get ₹3 back as store credit")).toBeVisible();
    await expect(summary.getByText('Free', { exact: true })).toBeVisible();
    await expect(summary.getByText(/more for free delivery/)).toHaveCount(0);
  } finally {
    const current = await (await admin.request.get('/api/admin/loyalty')).json();
    await admin.request.put('/api/admin/loyalty', {
      data: { enabled: false, silver: current.silver, gold: current.gold },
    });
  }
});
