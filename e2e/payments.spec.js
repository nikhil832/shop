import { test, expect } from '@playwright/test';

// Razorpay's checkout script is replaced with a stub: "paying" asks the stand-in Razorpay (port 4101, started by
// playwright.config.js) for a signed payment, exactly what the real window hands back. It asks through a razorpay.com
// address, sent on to the stand-in below, since the store's security policy lets pages talk only to itself and
// Razorpay. Set window.__razorpayAction to 'dismiss' to simulate closing the window instead.
const CHECKOUT_STUB = `
window.Razorpay = function (options) {
  this.open = async function () {
    window.__razorpayOptions = options;
    if (window.__razorpayAction === 'dismiss') return setTimeout(() => options.modal.ondismiss(), 0);
    const res = await fetch('https://api.razorpay.com/test/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: options.order_id }),
    });
    options.handler(await res.json());
  };
};`;

const PHONE = '/p/orbit-a14-4gb-ram-64gb'; // ₹8,999, plenty of stock
const address = {
  'Mobile number': '9876543210',
  'Address (house, street, area)': '12 MG Road',
  City: 'Bengaluru',
  State: 'Karnataka',
  'PIN code': '560001',
};
const summary = (page) => page.getByRole('complementary', { name: 'Order summary' });

test.beforeEach(async ({ page }) => {
  await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: CHECKOUT_STUB }),
  );
  await page.route('https://api.razorpay.com/test/pay', (route) =>
    route.fetch({ url: 'http://localhost:4101/test/pay' }).then((response) => route.fulfill({ response })),
  );
});

// Registers a new customer, puts the phone in the cart and fills in checkout, ready to place the order.
async function readyToPay(page) {
  const email = `payer-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Name').fill('Asha Rao');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('button', { name: 'Asha' })).toBeVisible();
  await page.goto(PHONE);
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.goto('/checkout');
  for (const [label, value] of Object.entries(address)) await page.getByLabel(label).fill(value);
  return email;
}

test('paying online places the order', async ({ page }) => {
  const email = await readyToPay(page);
  // Online is offered, and chosen by default.
  await expect(page.getByRole('radio', { name: /Pay online/ })).toBeChecked();
  await page.getByRole('button', { name: 'Place order · ₹8,999' }).click();

  await expect(page.getByRole('status')).toHaveText('Payment received. Thank you! Your order is placed.');
  await expect(page.locator('.order-head .status')).toHaveText('Placed');
  await expect(summary(page)).toContainText('Payment: Paid online');
  await expect(page.getByRole('link', { name: /^Cart, 0 items/ })).toBeVisible();

  // What the window was opened with: a test key, the exact amount in paise, and the customer's details.
  const options = await page.evaluate(() => globalThis.__razorpayOptions);
  expect(options.key).toMatch(/^rzp_test_/);
  expect(options.amount).toBe(899900);
  expect(options.currency).toBe('INR');
  expect(options.prefill).toEqual({ name: 'Asha Rao', email, contact: '9876543210' });
});

test('closing the window leaves the order awaiting payment, and "Pay now" finishes it', async ({ page }) => {
  await readyToPay(page);
  await page.evaluate(() => (globalThis.__razorpayAction = 'dismiss'));
  await page.getByRole('button', { name: 'Place order · ₹8,999' }).click();

  await expect(page.locator('.order-head .status')).toHaveText('Awaiting payment');
  await expect(page.locator('.notice.awaiting')).toContainText('Waiting for your payment of ₹8,999');
  await expect(summary(page)).toContainText('Payment: Online · not paid');

  await page.evaluate(() => (globalThis.__razorpayAction = 'pay'));
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page.locator('.order-head .status')).toHaveText('Placed');
  await expect(page.getByRole('status')).toHaveText('Payment received. Thank you! Your order is placed.');
});

test('cancelling a paid order refunds it', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept());
  await readyToPay(page);
  await page.getByRole('button', { name: 'Place order · ₹8,999' }).click();
  await expect(page.locator('.order-head .status')).toHaveText('Placed');

  await page.getByRole('button', { name: 'Cancel order' }).click();
  await expect(page.getByText('Your payment will be refunded in full.')).toBeVisible();
  await page.getByRole('radio', { name: 'Changed my mind' }).check();
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.locator('.order-head .status')).toHaveText('Cancelled');
  await expect(summary(page)).toContainText('Payment: Paid online · refund started');
});

test('Cash on Delivery is still offered next to online payment', async ({ page }) => {
  await readyToPay(page);
  await page.getByRole('radio', { name: /Cash on Delivery/ }).check();
  await page.getByRole('button', { name: 'Place order · ₹8,999' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Order placed! Please keep ₹8,999 ready to pay in cash on delivery.',
  );
  await expect(summary(page)).toContainText('Payment: Cash on Delivery');
});
