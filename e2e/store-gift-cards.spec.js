import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
// Razorpay's checkout replaced as in payments.spec.js: "paying" asks the stand-in Razorpay through a razorpay.com
// address (the security policy allows only those), routed below to port 4101.
const CHECKOUT_STUB = `
window.Razorpay = function (options) {
  this.open = async function () {
    const res = await fetch('https://api.razorpay.com/test/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: options.order_id }),
    });
    options.handler(await res.json());
  };
};`;

test.beforeEach(async ({ page }) => {
  await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: CHECKOUT_STUB }),
  );
  await page.route('https://api.razorpay.com/test/pay', (route) =>
    route.fetch({ url: 'http://localhost:4101/test/pay' }).then((response) => route.fulfill({ response })),
  );
});

test('a customer buys a gift card for a friend; an admin can cancel it and refund them', async ({ page, browser }) => {
  const stamp = Date.now().toString(36);
  const friend = `friend-${stamp}@example.com`;
  await page.request.post('/api/auth/register', {
    data: { name: 'Asha Rao', email: `gifter-${stamp}@example.com`, password: 'password123' },
  });
  await page.goto('/');
  await page.getByRole('contentinfo').getByRole('link', { name: 'Gift cards' }).click();
  await expect(page.getByRole('heading', { name: 'Gift cards', level: 1 })).toBeVisible();

  await page.getByRole('radio', { name: '₹2,000' }).check();
  await page.getByLabel('Their name').fill('Ravi Kumar');
  await page.getByLabel('Their email').fill(friend);
  await page.getByLabel(/^A message/).fill('Happy Diwali!');
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await page.getByRole('button', { name: 'Pay ₹2,000' }).click();
  await expect(page.getByRole('status')).toHaveText(
    `Paid! Your ₹2,000 gift card for Ravi Kumar has been emailed to ${friend}.`,
  );
  const bought = page.getByRole('region', { name: 'Gift cards you bought' });
  await expect(bought).toContainText(`₹2,000 for Ravi Kumar (${friend}) · Sent`);

  // A wrong code is refused.
  await page.getByLabel('Gift card code').fill('AAAA-BBBB-CCCC-DDDD');
  await page.getByRole('button', { name: 'Add to my store credit' }).click();
  await expect(page.getByRole('alert')).toHaveText('That code isn’t right. Check it and try again.');

  // The admin cancels it: the buyer is refunded.
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await admin.goto('/admin/gift-cards');
  const row = admin.getByRole('row').filter({ hasText: friend });
  await expect(row).toContainText('Sent');
  admin.once('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: /^Cancel and refund/ }).click();
  await expect(row).toContainText('Refund started');
  await page.reload();
  await expect(bought).toContainText('Cancelled');
});
