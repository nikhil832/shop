import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Named store-* to run after catalog.spec.js. Gift wrapping is a store-wide setting: switched on here and off again in
// `finally`, as every spec shares one server.
const axe = async (page, selector) =>
  (await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa']).analyze()).violations;
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const BOOK = '/p/the-quiet-engineer-paperback'; // ₹349, high stock
const address = {
  'Mobile number': '9876543210',
  'Address (house, street, area)': '12 MG Road',
  City: 'Bengaluru',
  State: 'Karnataka',
  'PIN code': '560001',
};

test('a customer sends an order as a gift, wrapped and with a message, which the packing slip shows', async ({
  page,
  browser,
}) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  // The admin switches wrapping on in Admin → Delivery.
  await admin.goto('/admin/delivery');
  const form = admin.getByRole('form', { name: 'Gift wrapping' });
  await form.getByLabel('Offer gift wrapping at checkout').check();
  await form.getByLabel('Fee (₹)').fill('49');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('status')).toHaveText('Saved.');
  try {
    await page.request.post('/api/auth/register', {
      data: { name: 'Asha Rao', email: `gift-${Date.now()}@example.com`, password: 'password123' },
    });
    await page.goto(BOOK);
    await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
    await page.goto('/checkout');
    for (const [label, value] of Object.entries(address)) await page.getByLabel(label).fill(value);
    await page.getByRole('radio', { name: /Cash on Delivery/ }).check();

    const gift = page.getByRole('region', { name: 'Gift options' });
    await gift.getByLabel('This is a gift').check();
    await gift.getByLabel('Gift message (optional)').fill('Happy birthday, Ravi! Love, Asha');
    await expect(gift).toContainText('With Cash on Delivery, the person receiving it pays ₹389.');
    await gift.getByLabel('Gift wrap it (+₹49)').check();
    const summary = page.getByRole('complementary', { name: 'Order summary' });
    await expect(summary).toContainText('Gift wrapping₹49');
    expect(await axe(page, '.gift-options')).toEqual([]);
    await page.getByRole('button', { name: 'Place order · ₹438' }).click(); // ₹349 + ₹40 delivery + ₹49

    await expect(page).toHaveURL(/\/orders\/[0-9a-f]{24}$/);
    const orderId = page.url().split('/').pop();
    const details = page.getByRole('region', { name: 'Gift' });
    await expect(details).toContainText('Gift wrapped, with no prices on the packing slip.');
    await expect(details).toContainText('Happy birthday, Ravi! Love, Asha');
    expect(await axe(page, '.gift-details')).toEqual([]);

    await admin.goto(`/admin/orders/slips?ids=${orderId}`);
    await expect(admin.locator('.slip-gift')).toContainText('Gift: gift wrap it');
    await expect(admin.locator('.slip-gift')).toContainText('“Happy birthday, Ravi! Love, Asha”');
  } finally {
    await admin.request.put('/api/admin/gift-wrap', { data: { enabled: false, fee: 4900 } });
  }
});
