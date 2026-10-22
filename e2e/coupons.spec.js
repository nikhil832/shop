import { test, expect } from '@playwright/test';

// Runs after catalog.spec.js (it buys a high-stock phone those tests don't count).
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const PHONE = '/p/orbit-a14-4gb-ram-64gb'; // ₹8,999
const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const address = {
  'Mobile number': '9876543210',
  'Address (house, street, area)': '12 MG Road',
  City: 'Bengaluru',
  State: 'Karnataka',
  'PIN code': '560001',
};

test('an admin creates a coupon and a customer uses it at checkout', async ({ page, browser }) => {
  const code = `E2E${unique().replace('-', '').slice(-10)}`;

  // The admin creates 10% off, up to ₹2,000.
  await page.goto('/login?next=/admin/coupons');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Coupons', level: 1 })).toBeVisible();
  const form = page.getByRole('form', { name: 'New coupon' });
  await form.getByLabel('Code').fill(code.toLowerCase());
  await form.getByLabel('Percent off').fill('10');
  await form.getByLabel('Maximum discount, ₹ (optional)').fill('2000');
  await form.getByRole('button', { name: 'Create coupon' }).click();
  const row = page.getByRole('row', { name: new RegExp(code) });
  await expect(row).toContainText('10% off (up to ₹2,000)');
  await expect(row).toContainText('On');

  // A customer, in a browser of their own.
  const customer = await (await browser.newContext()).newPage();
  const email = `coupon-${unique()}@example.com`;
  await customer.request.post('/api/auth/register', { data: { name: 'Asha Rao', email, password: 'password123' } });
  await customer.goto(PHONE);
  await customer.getByRole('button', { name: 'Add to cart' }).click();
  await customer.goto('/checkout');
  for (const [label, value] of Object.entries(address)) await customer.getByLabel(label).fill(value);
  await customer.getByRole('radio', { name: /Cash on Delivery/ }).check();

  const summary = customer.getByRole('complementary', { name: 'Order summary' });
  const box = customer.getByLabel('Coupon code');
  await box.fill('NOSUCHCODE');
  await box.press('Enter'); // applies the code; doesn't place the order
  await expect(summary.getByRole('alert')).toHaveText("This coupon code isn't valid");
  await expect(customer).toHaveURL('/checkout');

  await box.fill(code.toLowerCase());
  await summary.getByRole('button', { name: 'Apply' }).click();
  await expect(summary).toContainText(`${code} applied`);
  await expect(summary).toContainText(`Coupon (${code})−₹899`);
  await customer.getByRole('button', { name: 'Place order · ₹8,100' }).click();
  await expect(customer.getByRole('status')).toContainText('Order placed!');
  await expect(customer.getByRole('complementary', { name: 'Order summary' })).toContainText(`Coupon (${code})−₹899`);

  // The admin sees it used once.
  await page.reload();
  await expect(
    page
      .getByRole('row', { name: new RegExp(code) })
      .getByRole('cell')
      .nth(3),
  ).toHaveText('1');
  await page
    .getByRole('row', { name: new RegExp(code) })
    .getByRole('button', { name: /Switch off/ })
    .click();
  await expect(page.getByRole('row', { name: new RegExp(code) })).toContainText('Off');
});
