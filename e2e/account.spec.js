import { test, expect } from '@playwright/test';

const uniqueEmail = () => `account-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

test('the account page changes the name and password', async ({ page }) => {
  const email = uniqueEmail();
  await page.goto('/register');
  await page.getByLabel('Name').fill('Asha Rao');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('banner').getByRole('button', { name: 'Asha' })).toBeVisible();
  await page.goto('/orders');
  await page.getByRole('link', { name: 'Account' }).click();
  await expect(page).toHaveURL('/account');

  // Name: the header greets the new first name.
  const details = page.getByRole('form', { name: 'Your details' });
  await details.getByLabel('Name').fill('Meera Iyer');
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(details.getByRole('status')).toHaveText('Saved');
  await expect(page.getByRole('banner').getByRole('button', { name: 'Meera' })).toBeVisible();

  // Password: the current one is required and can't be reused.
  const password = page.getByRole('form', { name: 'Change password' });
  await password.getByLabel('Current password').fill('password123');
  await password.getByLabel(/^New password/).fill('password123');
  await password.getByLabel('Type the new password again').fill('password123');
  await password.getByRole('button', { name: 'Change password' }).click();
  await expect(password.getByRole('alert')).toHaveText('Your new password must be different from your current one.');

  await password.getByLabel(/^New password/).fill('brand new password');
  await password.getByLabel('Type the new password again').fill('brand new password');
  await password.getByRole('button', { name: 'Change password' }).click();
  await expect(password.getByRole('status')).toHaveText(
    "Password changed. You've been logged out on your other devices.",
  );
  await expect(password.getByLabel('Current password')).toHaveValue('');

  // The new password works for a fresh login.
  const res = await page.request.post('/api/auth/login', { data: { email, password: 'brand new password' } });
  expect(res.ok()).toBe(true);
});

test('the account page needs a login', async ({ page }) => {
  await page.goto('/account');
  await expect(page).toHaveURL('/login?next=/account');
});

// The demo server never sends email, so confirming with a real link is covered by the API tests; this checks the
// form, the waiting state and the confirmation page around it.
test('asking for a new email shows it as waiting until confirmed, and can be cancelled', async ({ page }) => {
  const email = uniqueEmail();
  await page.goto('/register');
  await page.getByLabel('Name').fill('Asha Rao');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('banner').getByRole('button', { name: 'Asha' })).toBeVisible();
  await page.goto('/account');

  const section = page.getByRole('form', { name: 'Email' });
  await expect(section).toContainText(`You log in with ${email}`);
  await section.getByLabel('New email').fill(`new-${email}`);
  await section.getByLabel('Your password').fill('wrong password');
  await section.getByRole('button', { name: 'Send confirmation link' }).click();
  await expect(section.getByRole('alert')).toHaveText('Your password is wrong');

  await section.getByLabel('Your password').fill('password123');
  await section.getByRole('button', { name: 'Send confirmation link' }).click();
  await expect(section.getByText(`Waiting for you to confirm new-${email}`)).toBeVisible();
  // Still the old email until the link is opened.
  await expect(section).toContainText(`You log in with ${email}`);

  await section.getByRole('button', { name: 'Cancel the change' }).click();
  await expect(section.getByText('Email change cancelled.')).toBeVisible();
  await expect(section.getByText('Waiting for you to confirm')).toHaveCount(0);

  await page.goto('/confirm-email');
  await expect(page.getByText('This page needs the link from the confirmation email')).toBeVisible();
  await page.goto(`/confirm-email#token=${'x'.repeat(43)}`);
  await page.getByRole('button', { name: 'Confirm new email' }).click();
  await expect(page.getByRole('alert')).toContainText('This link has expired or was already used.');
});

test('a long email address wraps instead of widening the account pages on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const email = `a.very.long.name.for.shopping.${Date.now()}@example.com`;
  await page.request.post('/api/auth/register', { data: { name: 'Leela Nair', email, password: 'password123' } });
  for (const path of ['/account', '/orders']) {
    await page.goto(path);
    await expect(page.getByText(email).first()).toBeVisible();
    expect(await page.locator('html').evaluate((html) => html.scrollWidth), path).toBeLessThanOrEqual(390);
  }
});

test('the address book: add, label, edit, make default, remove, and choose at checkout', async ({ page }) => {
  const email = uniqueEmail();
  expect(
    (
      await page.request.post('/api/auth/register', { data: { name: 'Asha Rao', email, password: 'password123' } })
    ).ok(),
  ).toBe(true);
  await page.goto('/account#addresses');
  const book = page.getByRole('region', { name: 'Addresses' });
  await expect(book.getByText('No saved addresses yet.')).toBeVisible();

  async function add(label, line1, pincode) {
    await book.getByRole('button', { name: 'Add an address' }).click();
    const form = book.getByRole('form', { name: 'New address' });
    await form.getByLabel('Label (optional)').fill(label);
    await form.getByLabel('Mobile number').fill('9876543210');
    await form.getByLabel('Address (house, street, area)').fill(line1);
    await form.getByLabel('City').fill('Bengaluru');
    await form.getByLabel('State').fill('karnataka');
    await form.getByLabel('PIN code').fill(pincode);
    await form.getByRole('button', { name: 'Save address' }).click();
    await expect(book.getByRole('status')).toHaveText('Address added');
  }
  await add('Home', '12 MG Road', '560001');
  await add('Office', 'Prestige Tower', '560025');
  const cards = book.getByRole('listitem');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('HomeDefault');
  await expect(cards.first()).toContainText('Asha Rao, 12 MG Road, Bengaluru, Karnataka 560001 · 9876543210');

  // Edit the office, then make it the default: it moves to the top.
  await book.getByRole('button', { name: 'Edit Office' }).click();
  const edit = book.getByRole('form', { name: 'Edit Office' });
  await expect(edit.getByLabel('PIN code')).toHaveValue('560025');
  await edit.getByLabel('Address (house, street, area)').fill('5th floor, Prestige Tower');
  await edit.getByRole('button', { name: 'Save address' }).click();
  await expect(book.getByRole('status')).toHaveText('Address saved');
  await book.getByRole('button', { name: 'Make default: Office' }).click();
  await expect(book.getByRole('status')).toHaveText('Default address changed');
  await expect(cards.first()).toContainText('OfficeDefault');
  await expect(cards.first()).toContainText('5th floor, Prestige Tower');

  // Checkout offers both, the default chosen; a new address shows the form with "Save it" ticked.
  await page.goto('/p/the-quiet-engineer-paperback');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.goto('/checkout');
  const where = page.getByRole('group', { name: 'Delivery address' });
  await expect(where.getByRole('radio', { name: /^Office/ })).toBeChecked();
  await expect(where.getByLabel('Mobile number')).toHaveCount(0);
  await where.getByRole('radio', { name: 'A new address' }).check();
  await expect(where.getByLabel('Save it to my addresses')).toBeChecked();
  await where.getByRole('radio', { name: /^Home/ }).check();
  await expect(where.getByLabel('Mobile number')).toHaveCount(0);

  // Remove the default: the other becomes the default.
  await page.goto('/account#addresses');
  await book.getByRole('button', { name: 'Remove Office' }).click();
  await expect(book.getByRole('status')).toHaveText('Address removed');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('HomeDefault');
});

test('customers download their data and close their account', async ({ page }) => {
  const email = uniqueEmail();
  expect(
    (
      await page.request.post('/api/auth/register', { data: { name: 'Leela Das', email, password: 'password123' } })
    ).ok(),
  ).toBe(true);
  await page.goto('/account#your-data');
  const section = page.getByRole('region', { name: 'Your data' });

  const download = page.waitForEvent('download');
  await section.getByRole('link', { name: 'Download my data' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^bazaar-my-data-\d{4}-\d\d-\d\d\.json$/);
  const data = JSON.parse(await (await import('node:fs/promises')).readFile(await file.path(), 'utf8'));
  expect(data.account.email).toBe(email);

  await section.getByText('Close my account').first().click();
  await section.getByLabel('Your password').fill('password123');
  await section.getByLabel('I understand my account will be deleted').check();
  await section.getByRole('button', { name: 'Close my account' }).click();
  await expect(page.getByRole('heading', { name: 'Your account is closed' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();
  const login = await page.request.post('/api/auth/login', { data: { email, password: 'password123' } });
  expect(login.status()).toBe(401);
});
