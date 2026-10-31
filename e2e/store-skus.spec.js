import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// Valid GTIN-13s, a different one per run (codes are unique on the shared server): 12 digits, then the check digit.
function ean() {
  const body = `890${String(Date.now()).slice(-9)}`;
  const sum = [...body].reverse().reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return body + ((10 - (sum % 10)) % 10);
}

// Its own product (hidden again at the end), bought once by a new customer through the API.
test('an admin gives a product an SKU and barcode, finds it by scanning, and sees the SKU on the packing slip', async ({
  page,
  browser,
}) => {
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await page.request.get('/api/categories')).json();
  const stamp = Date.now().toString(36).toUpperCase();
  const title = `Kitwell Kettle ${stamp}`;
  const res = await page.request.post('/api/admin/products', {
    data: { title, brand: 'Kitwell', categoryId: category.id, price: 99900, mrp: 129900, stock: 20 },
  });
  expect(res.status()).toBe(201);
  const product = await res.json();
  const barcode = ean();
  try {
    await page.goto(`/admin/products/${product.id}`);
    await page.getByLabel(/^SKU/).fill(`kw-kettle-${stamp}`);
    await page.getByLabel(/^Barcode/).fill('1234567890123');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'barcode: A barcode is the 8, 12, 13 or 14 digits under the stripes',
    );
    await page.getByLabel(/^Barcode/).fill(barcode);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toContainText(`Saved “${title}”.`);

    // A scanner types the number and presses Enter.
    await page.getByRole('searchbox', { name: 'Find products' }).fill(barcode);
    await page.keyboard.press('Enter');
    const row = page.getByRole('row', { name: new RegExp(title) });
    await expect(row).toContainText(`SKU KW-KETTLE-${stamp}`);
    await expect(page.locator('tbody tr')).toHaveCount(1);

    // A customer buys it; the slip names the SKU for finding it on the shelf.
    const request = (await browser.newContext()).request;
    await request.post('/api/auth/register', {
      data: { name: 'Tara Bose', email: `skus-${Date.now()}@example.com`, password: 'password123' },
    });
    const quote = await (await request.get(`/api/cart?items=${product.id}:1`)).json();
    const order = await request.post('/api/orders', {
      data: {
        items: [{ productId: product.id, qty: 1 }],
        address: {
          name: 'Tara Bose',
          phone: '9123456780',
          line1: '4 Park Street',
          city: 'Kolkata',
          state: 'West Bengal',
          pincode: '700016',
        },
        expectedTotal: quote.total,
      },
    });
    expect(order.status()).toBe(201);
    const { id, number, items } = await order.json();
    expect(items[0].sku).toBeUndefined(); // customers never see it
    await page.goto(`/admin/orders/slips?ids=${id}`);
    await expect(page.getByRole('article', { name: `Packing slip for order #${number}` })).toContainText(
      `SKU KW-KETTLE-${stamp}`,
    );
  } finally {
    await page.request.patch(`/api/admin/products/${product.id}`, { data: { active: false } });
  }
});
