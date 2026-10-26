import { test, expect } from '@playwright/test';

// Named to run after catalog.spec.js, since it places orders. It only ships the two orders it places.
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// A Cash on Delivery order of one book, by a new customer, through the API (its own cookies).
async function placeOrder(browser, name) {
  const context = await browser.newContext();
  const request = context.request;
  const email = `slips-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await request.post('/api/auth/register', { data: { name, email, password: 'password123' } });
  const book = await (await request.get('/api/products/the-quiet-engineer-paperback')).json();
  const quote = await (await request.get(`/api/cart?items=${book.id}:2`)).json();
  const res = await request.post('/api/orders', {
    data: {
      items: [{ productId: book.id, qty: 2 }],
      address: {
        name,
        phone: '9123456780',
        line1: '4 Park Street',
        city: 'Kolkata',
        state: 'West Bengal',
        pincode: '700016',
      },
      expectedTotal: quote.total,
    },
  });
  expect(res.status()).toBe(201);
  const order = await res.json();
  await context.close();
  return order;
}

test('an admin prints packing slips for chosen orders, then ships them together', async ({ page, browser }) => {
  const first = await placeOrder(browser, 'Tara Bose');
  const second = await placeOrder(browser, 'Arjun Sen');

  await page.goto('/login?next=%2Fadmin%2Forders%3Fstatus%3Dplaced');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();

  await page.getByRole('checkbox', { name: `Select order #${first.number}` }).check();
  await page.getByRole('checkbox', { name: `Select order #${second.number}` }).check();
  const bar = page.getByRole('group', { name: 'Selected orders' });
  await expect(bar).toContainText('2 selected');

  // The slips: where each goes and what's in it, with the cash to collect, and no prices per item.
  await bar.getByRole('link', { name: 'Print packing slips' }).click();
  const slip = page.getByRole('article', { name: `Packing slip for order #${first.number}` });
  await expect(slip).toContainText('Tara Bose');
  await expect(slip).toContainText('Kolkata, West Bengal 700016');
  await expect(slip.getByRole('row', { name: /The Quiet Engineer/ })).toContainText('2');
  await expect(slip).toContainText(`Cash on Delivery: collect ₹${(first.total / 100).toLocaleString('en-IN')}.`);
  await expect(page.getByRole('article', { name: `Packing slip for order #${second.number}` })).toContainText(
    'Arjun Sen',
  );
  await expect(page.getByRole('button', { name: 'Print 2 slips' })).toBeVisible();

  // Back to the list: ship both at once.
  await page.getByRole('link', { name: '← Back to orders' }).click();
  await page.goto('/admin/orders?status=placed');
  await page.getByRole('checkbox', { name: `Select order #${first.number}` }).check();
  await page.getByRole('checkbox', { name: `Select order #${second.number}` }).check();
  page.once('dialog', (dialog) => dialog.accept());
  await bar.getByRole('button', { name: 'Mark shipped' }).click();
  await expect(page.getByRole('status')).toContainText('Marked 2 orders shipped.');
  await expect(page.getByRole('checkbox', { name: `Select order #${first.number}` })).toHaveCount(0);

  await page.goto(`/admin/orders/${first.id}`);
  await expect(page.getByText('Shipped').first()).toBeVisible();
});
