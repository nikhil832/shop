import { test, expect } from '@playwright/test';

// Runs before invoices.spec.js on the shared demo server, so it switches GST off again at the end.
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const GSTIN = '29ABCDE1234F1ZW'; // made up, with a correct check character

async function saveGst(page, enabled) {
  await page.goto('/admin/gst');
  const box = page.getByRole('checkbox', { name: /GST invoices/ });
  if ((await box.isChecked()) !== enabled) await box.click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText(
    enabled ? 'Orders placed from now on get tax invoices.' : 'GST invoices are off.',
  );
}

test('with GST on, a new order gets a tax invoice with CGST and SGST', async ({ page, browser }) => {
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await admin.goto('/login?next=%2Fadmin%2Fgst');
  await admin.getByLabel('Email').fill(ADMIN.email);
  await admin.getByLabel('Password').fill(ADMIN.password);
  await admin.getByRole('button', { name: 'Log in' }).click();
  await expect(admin.getByRole('heading', { name: 'GST', exact: true })).toBeVisible();

  // A typo in the GSTIN is caught before anything is saved.
  await admin.getByLabel('GSTIN', { exact: true }).fill('29ABCDE1234F1ZX');
  await admin.getByLabel('Business name (as registered)').fill('Bazaar Retail Pvt Ltd');
  await admin.getByLabel('Address (as registered)').fill('12 MG Road\nBengaluru 560001');
  await admin.getByLabel(/^State/).selectOption('Karnataka');
  await admin.getByLabel('Default rate').selectOption('18');
  await admin.getByLabel('GST rate for Books').selectOption('0');
  await admin.getByLabel('HSN code for Books').fill('4901');
  await admin.getByRole('checkbox', { name: /GST invoices/ }).click();
  await admin.getByRole('button', { name: 'Save' }).click();
  await expect(admin.getByRole('alert')).toContainText('typo');
  await admin.getByLabel('GSTIN', { exact: true }).fill(GSTIN.toLowerCase());
  await admin.getByRole('button', { name: 'Save' }).click();
  await expect(admin.getByRole('status')).toContainText('Orders placed from now on get tax invoices.');
  await expect(admin.getByLabel('GSTIN', { exact: true })).toHaveValue(GSTIN);

  try {
    // A customer orders a phone (no rate of its own: the default 18%) to Karnataka, the store's state.
    const email = `gst-${Date.now()}@example.com`;
    await page.request.post('/api/auth/register', { data: { name: 'Neha Shah', email, password: 'password123' } });
    const product = await (await page.request.get('/api/products/orbit-a14-4gb-ram-64gb')).json();
    const quote = await (await page.request.get(`/api/cart?items=${product.id}:1`)).json();
    const res = await page.request.post('/api/orders', {
      data: {
        items: [{ productId: product.id, qty: 1 }],
        address: {
          name: 'Neha Shah',
          phone: '9876543210',
          line1: '4 Brigade Road',
          city: 'Bengaluru',
          state: 'karnataka',
          pincode: '560025',
        },
        expectedTotal: quote.total,
      },
    });
    expect(res.status()).toBe(201);
    const order = await res.json();

    await page.goto(`/orders/${order.id}/invoice`);
    await expect(page.getByRole('heading', { name: 'Tax invoice' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Sold by' })).toContainText(`GSTIN ${GSTIN}`);
    await expect(page.getByRole('region', { name: 'Billed to' })).toContainText('Place of supply: Karnataka (29)');
    // ₹8,999 including 18%: ₹7,626.27 taxable, ₹1,372.73 tax, split ₹686.36 + ₹686.37.
    await expect(page.getByRole('row', { name: /^Taxable value/ })).toContainText('₹7,626.27');
    await expect(page.getByRole('row', { name: /^CGST/ })).toContainText('₹686.36');
    await expect(page.getByRole('row', { name: /^SGST/ })).toContainText('₹686.37');
    await expect(page.getByRole('row', { name: /^IGST/ })).toHaveCount(0);
    await expect(page.getByText('Prices include GST of ₹1,372.73.')).toBeVisible();
  } finally {
    await saveGst(admin, false);
    await adminContext.close();
  }
});
