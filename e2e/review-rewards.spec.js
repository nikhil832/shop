import { test, expect } from '@playwright/test';

// Review rewards (stage 145). Switched off again at the end: every spec shares one demo server. Paying is covered by
// the API tests (it waits 3 days).
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const SLUG = 'the-quiet-engineer-paperback';
const address = {
  name: 'Riya Sen',
  phone: '9123456780',
  line1: '7 Park Street',
  city: 'Kolkata',
  state: 'West Bengal',
  pincode: '700016',
};

test('an admin switches review rewards on and a buyer sees the offer in the review form', async ({ page, browser }) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  try {
    await admin.goto('/admin/reviews');
    await admin.getByText('Review rewards: off').click();
    const form = admin.getByRole('form', { name: 'Review rewards' });
    await form.getByLabel('Give review rewards').check();
    await form.getByLabel('Credit per review (₹)').fill('25');
    await form.getByRole('button', { name: 'Save review rewards' }).click();
    await expect(form.getByRole('status')).toHaveText('Saved.');
    await expect(admin.getByText('Review rewards: on, ₹25 a review')).toBeVisible();

    // A customer whose order of the book was delivered.
    await page.request.post('/api/auth/register', {
      data: { name: 'Riya Sen', email: `rewards-${Date.now().toString(36)}@example.com`, password: 'password123' },
    });
    const book = await (await page.request.get(`/api/products/${SLUG}`)).json();
    const quote = await (await page.request.get(`/api/cart?items=${book.id}:1`)).json();
    const order = await (
      await page.request.post('/api/orders', {
        data: { items: [{ productId: book.id, qty: 1 }], address, expectedTotal: quote.total },
      })
    ).json();
    for (const status of ['shipped', 'delivered']) {
      expect((await admin.request.post(`/api/admin/orders/${order.id}/status`, { data: { status } })).ok()).toBe(true);
    }
    await page.goto(`/p/${SLUG}#reviews`);
    await expect(page.locator('.reward-note')).toHaveText(
      'Add a photo and at least 50 characters to get ₹25 of store credit, a few days after your review goes up.',
    );
  } finally {
    const current = await (await admin.request.get('/api/admin/review-rewards')).json();
    await admin.request.put('/api/admin/review-rewards', {
      data: { enabled: false, amount: current.amount, minChars: current.minChars, monthlyCap: current.monthlyCap },
    });
  }
});
