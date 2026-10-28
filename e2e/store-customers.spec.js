import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const ADDRESS = {
  name: 'Meera Iyer',
  phone: '9123456780',
  line1: '4 Lake View',
  city: 'Chennai',
  state: 'Tamil Nadu',
  pincode: '600001',
};

test('an admin finds a customer, sees their orders and gives them store credit', async ({ page, browser }) => {
  const stamp = Date.now().toString(36);
  const name = `Meera ${stamp}`;
  const email = `meera-${stamp}@example.com`;
  const customer = (await browser.newContext()).request;
  await customer.post('/api/auth/register', { data: { name, email, password: 'password123' } });
  const { items } = await (await customer.get('/api/products?q=quiet%20engineer')).json();
  const quote = await (await customer.get(`/api/cart?items=${items[0].id}:2`)).json();
  const order = await (
    await customer.post('/api/orders', {
      data: { items: [{ productId: items[0].id, qty: 2 }], address: ADDRESS, expectedTotal: quote.total },
    })
  ).json();

  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await page.goto('/admin');
  await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Customers' }).click();
  const search = page.getByRole('searchbox', { name: 'Search customers' });
  await search.fill(stamp);
  await search.press('Enter');
  await expect(page).toHaveURL(new RegExp(`q=${stamp}`));
  const row = page.getByRole('row').filter({ hasText: email });
  await expect(row).toContainText(`₹${(quote.total / 100).toLocaleString('en-IN')}`); // spent
  await row.getByRole('link', { name }).click();

  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await expect(page.getByText('4 Lake View, Chennai, Tamil Nadu 600001')).toBeVisible();
  const orders = page.getByRole('region', { name: 'Orders' });
  await expect(orders.getByRole('link', { name: `#${order.number}` })).toBeVisible();

  const credit = page.getByRole('region', { name: 'Store credit' });
  await expect(credit.getByText(`${name} has ₹0 of store credit.`)).toBeVisible();
  await credit.getByLabel('Amount (₹)').fill('250');
  await credit.getByLabel(/^Why/).fill('Thanks for being a regular');
  await credit.getByRole('button', { name: 'Give credit' }).click();
  await expect(credit.getByRole('status')).toHaveText(`Added ₹250. ${name} now has ₹250.`);
  await expect(credit.getByRole('listitem').first()).toContainText('Thanks for being a regular');
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // The order page links back to the customer.
  await orders.getByRole('link', { name: `#${order.number}` }).click();
  await page.getByRole('link', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
});
