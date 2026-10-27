import { test, expect } from '@playwright/test';

// Shares the demo server with catalog.spec.js, so it buys only high-stock items those tests don't count,
// and each test makes its own account.
const BOOK = '/p/the-quiet-engineer-paperback'; // ₹349, below the free-delivery threshold
const PHONE = '/p/orbit-a14-4gb-ram-64gb'; // ₹8,999

const summary = (page) => page.getByRole('complementary', { name: 'Order summary' });
const cartLink = (page) => page.getByRole('link', { name: /^Cart, / });
const uniqueEmail = () => `buyer-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

const address = {
  'Mobile number': '9876543210',
  'Address (house, street, area)': '12 MG Road',
  City: 'Bengaluru',
  State: 'Karnataka',
  'PIN code': '560001',
};

async function addToCart(page, path) {
  await page.goto(path);
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByRole('link', { name: /Go to cart/ })).toBeVisible();
}

test('guests can fill a cart, change quantities and see the delivery charge', async ({ page }) => {
  await page.goto('/cart');
  await expect(page.getByRole('heading', { name: 'Your cart is empty' })).toBeVisible();

  await addToCart(page, BOOK);
  await expect(cartLink(page)).toHaveAccessibleName('Cart, 1 item');
  await cartLink(page).click();

  await expect(page.getByRole('heading', { name: 'Cart (1)' })).toBeVisible();
  await expect(summary(page)).toContainText('Items (1)₹349');
  await expect(summary(page)).toContainText('Delivery₹40');
  await expect(summary(page)).toContainText('Total₹389');
  await expect(summary(page)).toContainText('Add ₹150 more for free delivery.');

  await page.getByLabel('Quantity of The Quiet Engineer (Paperback)').selectOption('2');
  await expect(summary(page)).toContainText('DeliveryFree');
  await expect(summary(page)).toContainText('Total₹698');
  await expect(cartLink(page)).toHaveAccessibleName('Cart, 2 items');

  // The cart survives a reload (it's kept in the browser).
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Cart (2)' })).toBeVisible();

  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('heading', { name: 'Your cart is empty' })).toBeVisible();
  await expect(cartLink(page)).toHaveAccessibleName('Cart, 0 items');
});

test('checkout asks to log in, places a COD order, and the order can be cancelled', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept());
  await addToCart(page, PHONE);
  await page.goto('/cart');
  await page.getByRole('button', { name: 'Checkout' }).click();

  // Not logged in: off to the login page, then to sign-up, and back to checkout.
  await expect(page).toHaveURL('/login?next=/checkout');
  await page.getByRole('link', { name: 'Create an account' }).click();
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await page.getByLabel('Name').fill('Asha Rao');
  await page.getByLabel('Email').fill(uniqueEmail());
  await page.getByLabel('Password').fill('correct horse');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page).toHaveURL('/checkout');
  await expect(page.getByRole('link', { name: 'Asha' })).toBeVisible();
  await expect(page.getByLabel('Full name')).toHaveValue('Asha Rao');
  for (const [label, value] of Object.entries(address)) await page.getByLabel(label).fill(value);
  await page.getByRole('radio', { name: /Cash on Delivery/ }).check();
  await expect(summary(page)).toContainText('Total₹8,999');
  await page.getByRole('button', { name: 'Place order · ₹8,999' }).click();

  await expect(page).toHaveURL(/\/orders\/[0-9a-f]{24}$/);
  await expect(page.getByRole('status')).toHaveText(
    'Order placed! Please keep ₹8,999 ready to pay in cash on delivery.',
  );
  await expect(page.locator('.order-head .status')).toHaveText('Placed');
  await expect(page.getByText('Orbit A14 (4GB RAM, 64GB)')).toBeVisible();
  await expect(page.locator('address')).toContainText('Bengaluru, Karnataka 560001');
  await expect(cartLink(page)).toHaveAccessibleName('Cart, 0 items');
  const orderHeading = await page.getByRole('heading', { level: 1 }).textContent();

  await page.getByRole('link', { name: 'My orders' }).click();
  await expect(page.locator('.order-card')).toHaveCount(1);
  await expect(page.locator('.order-card')).toContainText(orderHeading);
  await page.locator('.order-card').click();

  await page.getByRole('button', { name: 'Cancel order' }).click();
  await expect(page.locator('.order-head .status')).toHaveText('Cancelled');
  await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
});

test('the address is saved to the address book, and logging out and back in works', async ({ page }) => {
  const email = uniqueEmail();
  await page.goto('/register');
  await page.getByLabel('Name').fill('Ravi Kumar');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('link', { name: 'Ravi' })).toBeVisible();

  await addToCart(page, BOOK);
  await page.goto('/checkout');
  for (const [label, value] of Object.entries(address)) await page.getByLabel(label).fill(value);
  await page.getByRole('radio', { name: /Cash on Delivery/ }).check();
  await expect(summary(page)).toContainText('Delivery₹40');
  await page.getByRole('button', { name: 'Place order · ₹389' }).click();
  await expect(page.getByRole('status')).toContainText('Order placed!');

  // The address went into the address book: the next checkout offers it, chosen.
  await addToCart(page, BOOK);
  await page.goto('/checkout');
  await expect(page.getByRole('radio', { name: /Ravi Kumar/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /Ravi Kumar/ })).toHaveAccessibleName(/12 MG Road.*560001/);
  await expect(page.getByLabel('Mobile number')).toHaveCount(0);

  await page.getByRole('link', { name: 'Ravi' }).click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();

  await page.goto('/orders');
  await expect(page).toHaveURL('/login?next=/orders');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('wrong password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong email or password');

  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL('/orders');
  await expect(page.locator('.order-card')).toHaveCount(1);
});
