import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Named to run after catalog.spec.js, since it places orders (of a high-stock book).
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

async function placeOrder(browser, name, qty) {
  const request = (await browser.newContext()).request;
  const email = `labels-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await request.post('/api/auth/register', { data: { name, email, password: 'password123' } });
  const book = await (await request.get('/api/products/the-quiet-engineer-paperback')).json();
  const quote = await (await request.get(`/api/cart?items=${book.id}:${qty}`)).json();
  const res = await request.post('/api/orders', {
    data: {
      items: [{ productId: book.id, qty }],
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
  return res.json();
}

test('an admin prints shipping labels for chosen orders, four to a sheet or one per label', async ({
  page,
  browser,
}) => {
  const first = await placeOrder(browser, 'Tara Bose', 1);
  const second = await placeOrder(browser, 'Arjun Sen', 3);
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  // The first one already has its courier.
  const shipped = await page.request.post(`/api/admin/orders/${first.id}/status`, {
    data: { status: 'shipped', shipment: { courier: 'Delhivery', trackingNumber: 'DL123456', trackingUrl: '' } },
  });
  expect(shipped.ok()).toBe(true);

  await page.goto('/admin/orders');
  await page.getByRole('checkbox', { name: `Select order #${first.number}` }).check();
  await page.getByRole('checkbox', { name: `Select order #${second.number}` }).check();
  await page
    .getByRole('group', { name: 'Selected orders' })
    .getByRole('link', { name: 'Print shipping labels' })
    .click();

  const label = (o) => page.getByRole('article', { name: `Shipping label for order #${o.number}` });
  await expect(label(first)).toContainText(`#${first.number}`);
  await expect(label(first)).toContainText('PIN 700016');
  await expect(label(first)).toContainText(`Cash on Delivery: collect ₹${(first.total / 100).toLocaleString('en-IN')}`);
  await expect(label(first)).toContainText('Delhivery');
  await expect(label(first)).toContainText('DL123456');
  // No courier yet: lines to write on. Units, not lines, are counted.
  await expect(label(second)).toContainText('not set yet');
  await expect(label(second).getByRole('definition').last()).toHaveText('3');
  await expect(label(second)).toContainText('FromBazaar');
  await expect(page.getByRole('button', { name: 'Print 2 labels' })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);

  // The layout is kept in the address, so a refresh or a shared link prints the same way.
  await page.getByLabel('Print').selectOption({ label: 'One per page (4 × 6 inch label printer)' });
  await expect(page).toHaveURL(/layout=roll/);
  await expect(page.locator('.label-sheet')).toHaveCount(2);
  await page.getByRole('link', { name: 'Packing slips' }).click();
  await expect(page.getByRole('article', { name: `Packing slip for order #${first.number}` })).toBeVisible();
  await page.getByRole('link', { name: 'Shipping labels' }).click();
  await expect(page.locator('.label-sheet')).toHaveCount(1);
});
