import { test, expect } from '@playwright/test';

const ADDRESS = {
  'Mobile number': '9876543210',
  'Address (house, street, area)': '4 Lake View',
  City: 'Chennai',
  State: 'Tamil Nadu',
  'PIN code': '600001',
};

test('a new shopper checks out with a name and email; the account is made and asks for a password later', async ({
  page,
}) => {
  const email = `quick-${Date.now()}@example.com`;
  await page.goto('/p/the-quiet-engineer-paperback');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.goto('/checkout');

  await expect(page.getByRole('heading', { name: 'Your details' })).toBeVisible();
  await page.getByLabel('Your name').fill('Meera Iyer');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Full name').fill('Meera Iyer');
  for (const [label, value] of Object.entries(ADDRESS)) await page.getByLabel(label).fill(value);
  await page.getByRole('radio', { name: /Cash on Delivery/ }).check();
  await page.getByRole('button', { name: 'Place order · ₹389' }).click();

  await expect(page).toHaveURL(/\/orders\/[0-9a-f]{24}$/);
  await expect(page.getByRole('status')).toContainText('Order placed!');
  // Logged in as the new account, which has no password yet.
  await expect(page.getByRole('link', { name: 'Meera' })).toBeVisible();
  await page.goto('/account');
  const password = page.getByRole('region', { name: 'Password' });
  await expect(password).toContainText('it has no password yet');
  await password.getByRole('button', { name: 'Email me a link to set a password' }).click();
  await expect(password.getByRole('status')).toHaveText(`We've emailed a link to ${email}. It works for an hour.`);
});

test('an email that already has an account is asked to log in', async ({ page, request }) => {
  const email = `taken-${Date.now()}@example.com`;
  await request.post('/api/auth/register', { data: { name: 'Ravi', email, password: 'password123' } });
  await page.goto('/p/the-quiet-engineer-paperback');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.goto('/checkout');
  await page.getByLabel('Your name').fill('Ravi');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Full name').fill('Ravi');
  for (const [label, value] of Object.entries(ADDRESS)) await page.getByLabel(label).fill(value);
  await page.getByRole('radio', { name: /Cash on Delivery/ }).check();
  await page.getByRole('button', { name: 'Place order · ₹389' }).click();
  await expect(page.getByRole('alert')).toHaveText('There’s already an account with this email: log in to check out');
});
