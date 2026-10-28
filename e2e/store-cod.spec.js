import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const ADDRESS = {
  name: 'Asha Rao',
  phone: '9123456780',
  line1: '12 Hill Road',
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411001',
};

test('parcels that come back refused stop Cash on Delivery for that customer, until an admin allows it', async ({
  page,
  browser,
}) => {
  const stamp = Date.now().toString(36);
  const name = `Kiran ${stamp}`;
  await page.request.post('/api/auth/register', {
    data: { name, email: `cod-${stamp}@example.com`, password: 'password123' },
  });
  const { items } = await (await page.request.get('/api/products?q=quiet%20engineer')).json();
  const book = items[0];
  const order = async () => {
    const quote = await (await page.request.get(`/api/cart?items=${book.id}:1`)).json();
    return (
      await page.request.post('/api/orders', {
        data: { items: [{ productId: book.id, qty: 1 }], address: ADDRESS, expectedTotal: quote.total },
      })
    ).json();
  };

  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const returned = [];
  for (const reason of ['refused', 'unreachable']) {
    const o = await order();
    returned.push(o);
    await admin.request.post(`/api/admin/orders/${o.id}/status`, { data: { status: 'shipped' } });
    if (reason === 'unreachable') {
      // The second one through the admin page.
      await admin.goto(`/admin/orders/${o.id}`);
      await admin.getByText('Returned to sender', { exact: true }).click();
      await admin.getByLabel('Why it came back').selectOption('unreachable');
      admin.once('dialog', (d) => d.accept());
      await admin.getByRole('button', { name: 'Mark returned to sender' }).click();
      await expect(admin.getByText('Returned to sender: Customer couldn’t be reached')).toBeVisible();
    } else {
      await admin.request.post(`/api/admin/orders/${o.id}/returned`, { data: { reason } });
    }
  }

  // Checkout now offers only online payment, and says why.
  await page.goto('/p/the-quiet-engineer-paperback');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.goto('/checkout');
  // The earlier orders' address is in the address book, so checkout starts with it.
  await expect(page.getByRole('radio', { name: /Cash on Delivery/ })).toBeDisabled();
  await expect(
    page.getByText('Some earlier Cash on Delivery orders came back undelivered, so please pay online.'),
  ).toBeVisible();
  // The order page tells the customer what happened.
  await page.goto(`/orders/${returned[0].id}`);
  await expect(page.getByText(/came back undelivered on .* \(refused by the customer\)/)).toBeVisible();

  // The admin allows it again from the customer's page.
  await admin.goto('/admin/customers?q=' + stamp);
  await admin.getByRole('link', { name }).click();
  const cod = admin.getByRole('region', { name: 'Cash on Delivery' });
  await expect(cod).toContainText('2 Cash on Delivery orders came back refused or unreachable. They must pay online.');
  await cod.getByRole('button', { name: 'Allow Cash on Delivery again' }).click();
  // Only later refusals count now, so there's nothing to show.
  await expect(cod).toHaveCount(0);
  await page.goto('/checkout');
  await expect(page.getByRole('radio', { name: /Cash on Delivery/ })).toBeEnabled();
});

test('an admin sets the largest Cash on Delivery order; bigger ones must be paid online', async ({ page, browser }) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await admin.goto('/admin/delivery');
  const form = admin.getByRole('form', { name: 'Cash on Delivery' });
  try {
    await form.getByLabel('Largest order paid on delivery (₹)').fill('5000');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form.getByRole('status')).toHaveText('Saved.');

    await page.request.post('/api/auth/register', {
      data: { name: 'Big Spender', email: `big-${Date.now()}@example.com`, password: 'password123' },
    });
    await page.goto('/p/orbit-a14-4gb-ram-64gb'); // ₹8,999
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await page.goto('/checkout');
    await expect(page.getByText('Cash on Delivery is for orders up to ₹5,000; please pay online.')).toBeVisible();
    await expect(page.getByRole('radio', { name: /Cash on Delivery/ })).toBeDisabled();
  } finally {
    // Every spec shares this server: no limit again.
    await admin.request.put('/api/admin/cod', { data: { maxOrder: null, refusedLimit: 2 } });
  }
});
