import { test, expect } from '@playwright/test';

// One account on two devices (two browsers). The demo never sends email, so the API tests cover the reminder.
const BOOK = '/p/the-quiet-engineer-paperback';
const PHONE = '/p/orbit-a14-4gb-ram-64gb';
const cart = (page, n) => page.getByRole('link', { name: `Cart, ${n} ${n === 1 ? 'item' : 'items'}` });

async function logIn(page, email) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('button', { name: 'Leela' })).toBeVisible();
}

async function add(page, path) {
  await page.goto(path);
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByRole('link', { name: /Go to cart/ })).toBeVisible();
}

// Waits for this browser's cart to reach the account (saved 400 ms after the last change; slower when all specs run).
const savedCount = async (page) => (await (await page.request.get('/api/cart/saved')).json()).items.length;

test('a cart follows its account between devices, and logging out leaves it in the account', async ({ browser }) => {
  const email = `carts-${Date.now()}@example.com`;
  const phone = await (await browser.newContext()).newPage();
  const laptop = await (await browser.newContext()).newPage();
  await phone.request.post('/api/auth/register', { data: { name: 'Leela Nair', email, password: 'password123' } });
  await phone.request.post('/api/auth/logout');

  // A guest cart on the phone joins the account on login.
  await add(phone, BOOK);
  await logIn(phone, email);
  await expect(cart(phone, 1)).toBeVisible();
  await expect.poll(() => savedCount(phone), { timeout: 10_000 }).toBe(1);

  // The laptop gets it on login, and adds to it.
  await logIn(laptop, email);
  await expect(cart(laptop, 1)).toBeVisible();
  await add(laptop, PHONE);
  await expect(cart(laptop, 2)).toBeVisible();
  await expect.poll(() => savedCount(laptop), { timeout: 10_000 }).toBe(2);

  // Back on the phone's tab: the laptop's change is there.
  await phone.evaluate(() => globalThis.document.dispatchEvent(new globalThis.Event('visibilitychange')));
  await expect(cart(phone, 2)).toBeVisible();

  // Logging out empties the phone's cart; logging in again brings it back.
  await phone.goto('/orders');
  await phone.getByRole('button', { name: 'Log out' }).click();
  await expect(cart(phone, 0)).toBeVisible();
  await logIn(phone, email);
  await expect(cart(phone, 2)).toBeVisible();

  // Removed on the laptop: stays removed on the phone (its own copy isn't merged back).
  await laptop.goto('/cart');
  await laptop
    .getByRole('button', { name: /Remove/ })
    .first()
    .click();
  await expect(cart(laptop, 1)).toBeVisible();
  await expect.poll(() => savedCount(laptop), { timeout: 10_000 }).toBe(1);
  await phone.reload();
  await expect(cart(phone, 1)).toBeVisible();
});

test('the account page switches cart reminders off and on', async ({ page }) => {
  const email = `remind-${Date.now()}@example.com`;
  await page.request.post('/api/auth/register', { data: { name: 'Leela Nair', email, password: 'password123' } });
  await page.goto('/account');
  const box = page.getByRole('checkbox', { name: 'Remind me once about things left in my cart for a day' });
  await expect(box).toBeChecked();
  await box.click();
  await expect(page.getByRole('region', { name: 'Email updates' }).getByRole('status')).toHaveText(
    'Cart reminders are off.',
  );
  await page.reload();
  await expect(box).not.toBeChecked();
  await box.click();
  await expect(box).toBeChecked();
});

test('adding to the cart while the saved cart is still loading keeps the new item', async ({ page }) => {
  const email = `race-${Date.now()}@example.com`;
  await page.request.post('/api/auth/register', { data: { name: 'Leela Nair', email, password: 'password123' } });
  await add(page, BOOK);
  await expect.poll(() => savedCount(page), { timeout: 10_000 }).toBe(1);

  // The saved cart answers slowly on the next page load; the customer adds a phone meanwhile.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route('**/api/cart/saved', async (route) => {
    if (route.request().method() === 'GET') await held;
    await route.continue();
  });
  await page.goto(PHONE);
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(cart(page, 2)).toBeVisible();
  release();
  await page.waitForTimeout(500); // the saved cart has arrived
  await expect(cart(page, 2)).toBeVisible();
  await page.unroute('**/api/cart/saved');
  await expect.poll(() => savedCount(page), { timeout: 10_000 }).toBe(2);
});

test('an item added just before leaving the page is kept and saved', async ({ page }) => {
  const email = `leave-${Date.now()}@example.com`;
  await page.request.post('/api/auth/register', { data: { name: 'Leela Nair', email, password: 'password123' } });
  await page.goto(BOOK);
  await expect(page.getByRole('button', { name: 'Leela' })).toBeVisible();
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.goto('/cart'); // straight away, before the change is saved
  await expect(cart(page, 1)).toBeVisible();
  await expect.poll(() => savedCount(page), { timeout: 10_000 }).toBe(1);
});
