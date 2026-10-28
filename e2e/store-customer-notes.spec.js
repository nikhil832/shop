import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const ADDRESS = {
  name: 'Neha Joshi',
  phone: '9123456780',
  line1: '7 Park Street',
  city: 'Kolkata',
  state: 'West Bengal',
  pincode: '700016',
};

test('an admin tags a customer and notes something; both show on their orders', async ({ page, browser }) => {
  const stamp = Date.now().toString(36);
  const name = `Neha ${stamp}`;
  const customer = (await browser.newContext()).request;
  await customer.post('/api/auth/register', {
    data: { name, email: `notes-${stamp}@example.com`, password: 'password123' },
  });
  const { items } = await (await customer.get('/api/products?q=quiet%20engineer')).json();
  const quote = await (await customer.get(`/api/cart?items=${items[0].id}:1`)).json();
  const order = await (
    await customer.post('/api/orders', {
      data: { items: [{ productId: items[0].id, qty: 1 }], address: ADDRESS, expectedTotal: quote.total },
    })
  ).json();

  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await page.goto(`/admin/customers?q=${stamp}`);
  await page.getByRole('link', { name }).click();
  const tags = page.getByRole('group', { name: 'Tags' });
  await tags.getByRole('checkbox', { name: 'VIP' }).click();
  await expect(tags.getByRole('checkbox', { name: 'VIP' })).toBeChecked();
  await tags.getByRole('checkbox', { name: 'Watch' }).click();
  await expect(tags.getByRole('checkbox', { name: 'Watch' })).toBeChecked();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`${name}VIPWatch`);

  const notes = page.getByRole('region', { name: 'Notes' });
  await notes.getByLabel('Add a note').fill('Asked twice for delivery after 6 pm');
  await notes.getByRole('button', { name: 'Add note' }).click();
  await expect(notes.getByRole('listitem')).toContainText('Asked twice for delivery after 6 pm');
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // On the order, for whoever packs or answers it.
  await page.goto(`/admin/orders/${order.id}`);
  await expect(page.getByRole('list', { name: 'Notes about this customer' })).toContainText(
    'Asked twice for delivery after 6 pm',
  );
  await page.goto('/admin/orders');
  await expect(page.getByRole('row').filter({ hasText: name })).toContainText('VIPWatch');
  await page.goto('/admin/customers?tag=watch');
  await expect(page.getByRole('link', { name })).toBeVisible();
});
