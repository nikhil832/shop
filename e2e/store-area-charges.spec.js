import { test, expect } from '@playwright/test';

// Named store-* to run after catalog.spec.js. The area is deleted in `finally`, as every spec shares one server.
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

test('a far-off area adds a delivery charge, shown with the PIN check and at checkout', async ({ page, browser }) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const zone = await (
    await admin.request.post('/api/admin/delivery/zones', {
      data: { prefix: '793', name: 'Shillong', deliverable: true, minDays: 5, maxDays: 8, extraCharge: 6000 },
    })
  ).json();
  try {
    await admin.goto('/admin/delivery');
    await expect(admin.getByText('5–8 days, +₹60 delivery')).toBeVisible();

    await page.goto('/p/the-quiet-engineer-paperback');
    const check = page.getByRole('form', { name: 'Check delivery' });
    await check.getByLabel('Check delivery').fill('793001');
    await check.getByRole('button', { name: 'Check' }).click();
    await expect(page.locator('.delivery-result')).toContainText('₹60 extra for delivery there');

    await page.request.post('/api/auth/register', {
      data: { name: 'Asha Rao', email: `far-${Date.now()}@example.com`, password: 'password123' },
    });
    await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
    await page.goto('/checkout');
    for (const [label, value] of Object.entries({
      'Mobile number': '9876543210',
      'Address (house, street, area)': 'Police Bazaar',
      'PIN code': '793001',
      City: 'Shillong',
    })) {
      await page.getByLabel(label).fill(value);
    }
    await expect(page.getByLabel('State')).toHaveValue('Meghalaya'); // from the PIN code (stage 105)
    const summary = page.getByRole('complementary', { name: 'Order summary' });
    await expect(summary).toContainText('Includes ₹60 for this area');
    await page.getByRole('radio', { name: /Cash on Delivery/ }).check();
    await page.getByRole('button', { name: 'Place order · ₹449' }).click(); // ₹349 + ₹40 + ₹60
    await expect(page).toHaveURL(/\/orders\/[0-9a-f]{24}$/);
    await expect(page.getByRole('complementary', { name: 'Order summary' })).toContainText(
      'Includes ₹60 for this area',
    );
  } finally {
    await admin.request.delete(`/api/admin/delivery/zones/${zone.id}`);
  }
});
