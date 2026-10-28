import { test, expect } from '@playwright/test';

// The help form allows 5 requests an hour per network, shared with store-help.spec.js: this file uses one.
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const BOOK = '/p/the-quiet-engineer-paperback'; // ₹349 + ₹40 delivery
const ADDRESS = {
  'Mobile number': '9876543210',
  'Address (house, street, area)': '12 MG Road',
  City: 'Bengaluru',
  State: 'Karnataka',
  'PIN code': '560001',
};

test('an admin gives credit from a help request; the customer pays an order with it', async ({ page, browser }) => {
  const stamp = Date.now().toString(36);
  const name = `Kavya ${stamp}`;
  await page.request.post('/api/auth/register', {
    data: { name, email: `credit-${stamp}@example.com`, password: 'password123' },
  });
  const help = await page.request.post('/api/help', {
    data: { topic: 'order', message: 'My last parcel arrived a week late.' },
  });
  expect(help.ok()).toBe(true);

  // The admin opens the request and gives ₹500.
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await admin.goto('/admin/help');
  const card = admin.locator('li.question-card').filter({ hasText: name });
  await card.getByText(`Store credit for ${name}`).click();
  await expect(card.getByText(`${name} has ₹0 of store credit.`)).toBeVisible();
  await card.getByLabel('Amount (₹)').fill('500');
  await card.getByLabel(/^Why/).fill('Sorry about the late delivery');
  await card.getByRole('button', { name: 'Give credit' }).click();
  await expect(card.getByRole('status')).toHaveText(`Added ₹500. ${name} now has ₹500.`);

  // The customer sees it in their account…
  await page.goto('/account#credit');
  const credit = page.getByRole('region', { name: 'Store credit' });
  await expect(credit).toContainText('You have ₹500');
  await expect(credit).toContainText('Sorry about the late delivery');

  // …and checkout uses it: the book is paid in full, so there is nothing to choose.
  await page.goto(BOOK);
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.goto('/checkout');
  for (const [label, value] of Object.entries(ADDRESS)) await page.getByLabel(label).fill(value);
  const useCredit = page.getByRole('checkbox', { name: /Use my store credit/ });
  await expect(useCredit).toBeChecked();
  await expect(page.getByText('₹500 available: pays for the whole order.')).toBeVisible();
  await expect(page.getByText('Cash on Delivery')).toHaveCount(0);
  // Unticked, the customer pays it all.
  await useCredit.click();
  await expect(page.getByRole('button', { name: 'Place order · ₹389' })).toBeVisible();
  await useCredit.click();
  await page.getByRole('button', { name: 'Place order · ₹0' }).click();

  const summary = page.getByRole('complementary', { name: 'Order summary' });
  await expect(summary).toContainText('Store credit−₹389');
  await expect(summary).toContainText('Payment: Store credit');
  await page.goto('/account#credit');
  await expect(credit).toContainText('You have ₹111');
  await expect(credit.getByRole('listitem').first()).toContainText('Paid for an order');
});
