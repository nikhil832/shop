import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

// Named to run after catalog.spec.js (files run alphabetically on one shared demo server), since adding
// products and categories here would change the counts that file checks.
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function logIn(page, { email, password }, next = '/admin') {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(new RegExp(`${next}`));
}

// A customer order made through the API with its own cookies, separate from the page's admin session.
async function customerOrder(request) {
  const email = `customer-${unique()}@example.com`;
  expect(
    (await request.post('/api/auth/register', { data: { name: 'Meera Iyer', email, password: 'password123' } })).ok(),
  ).toBe(true);
  const { items } = await (await request.get('/api/products?q=quiet%20engineer')).json();
  const quote = await (await request.get(`/api/cart?items=${items[0].id}:1`)).json();
  const res = await request.post('/api/orders', {
    data: {
      items: [{ productId: items[0].id, qty: 1 }],
      address: {
        name: 'Meera Iyer',
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
  return { email, order: await res.json() };
}

test('customers see "Admins only" and no admin link', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Name').fill('Plain Customer');
  await page.getByLabel('Email').fill(`plain-${unique()}@example.com`);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('link', { name: 'Plain' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);

  await page.goto('/admin/orders');
  await expect(page.getByRole('heading', { name: 'Admins only' })).toBeVisible();
});

test('admin finds an order and moves it to shipped, then delivered', async ({ page, request }) => {
  const { email, order } = await customerOrder(request);
  await logIn(page, ADMIN, '/admin/orders');
  await expect(page.getByRole('link', { name: 'Admin' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible();

  await page.getByRole('searchbox', { name: 'Find orders' }).fill(email);
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  const rows = page.locator('.admin-table tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Meera Iyer');
  await rows.getByRole('link').click();

  await expect(page).toHaveURL(`/admin/orders/${order.id}`);
  await expect(page.locator('.admin-columns')).toContainText('Kolkata, West Bengal 700016');
  await page.getByRole('button', { name: 'Mark as shipped' }).click();
  await expect(page.locator('.order-head .status')).toHaveText('Shipped');
  await page.getByRole('button', { name: 'Mark as delivered' }).click();
  await expect(page.locator('.order-head .status')).toHaveText('Delivered');
  await expect(page.getByRole('button', { name: /Mark as|Cancel order/ })).toHaveCount(0);

  // The status tabs filter the list.
  await page.goto('/admin/orders?status=delivered');
  await expect(page.locator('.admin-table')).toContainText(email);
});

test('admin adds a product with a photo, edits stock, and hides it', async ({ page }) => {
  const title = `Test Lamp ${unique()}`;
  await logIn(page, ADMIN, '/admin/products');
  await page.getByRole('link', { name: 'Add product' }).click();

  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Brand').fill('Griha');
  await page.getByLabel('Category').selectOption({ label: 'Home & Kitchen' });
  await page.getByLabel('Price (₹)').fill('1299');
  await page.getByLabel('MRP (₹)').fill('1999');
  await page.getByLabel('Stock', { exact: true }).fill('7');
  await page.getByLabel('Highlights (one per line, up to 8)').fill('Warm light\nUSB-C');
  await page.locator('input[type=file]').setInputFiles({ name: 'lamp.png', mimeType: 'image/png', buffer: PNG });
  // Shrunk in the browser, with a small version shown here (photos.js).
  await expect(page.getByRole('img', { name: 'Image 1' })).toHaveAttribute(
    'src',
    /^\/api\/images\/[0-9a-f]{24}\?size=small$/,
  );
  await page.getByRole('button', { name: 'Add product' }).click();

  await expect(page.getByRole('status')).toHaveText(`Saved “${title}”.`);
  await page.getByRole('searchbox', { name: 'Find products' }).fill(title);
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  const row = page.locator('.admin-table tbody tr');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('₹1,299');

  // Quick stock edit from the list.
  const stock = page.getByLabel(`Stock of ${title}`);
  await stock.fill('3');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByRole('button', { name: 'Save' })).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel(`Stock of ${title}`)).toHaveValue('3');

  // In the store, with its uploaded photo.
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  await page.goto(`/p/${slug}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
  await expect(page.getByText('Only 3 left')).toBeVisible();
  await expect(page.locator('.gallery-main img')).toHaveAttribute('src', /^\/api\/images\//);

  // Hide it: gone from the store.
  await page.goBack();
  await page.getByRole('button', { name: `Hide ${title}` }).click();
  await expect(row.locator('.status')).toHaveText('Hidden');
  await page.goto(`/p/${slug}`);
  await expect(page.getByText("This product doesn't exist or is no longer sold.")).toBeVisible();
});

test('admin adds, renames, reorders and deletes a category', async ({ page }) => {
  const name = `Toys ${unique()}`;
  await logIn(page, ADMIN, '/admin/categories');
  await page.getByLabel('New category icon').fill('🧸');
  await page.getByLabel('New category name').fill(name);
  await page.getByRole('button', { name: 'Add category' }).click();
  await expect(page.getByLabel(`Name of ${name}`)).toBeVisible();
  await expect(page.getByRole('button', { name: `Delete ${name}` })).toBeEnabled();
  // Categories with products can't be deleted.
  await expect(page.getByRole('button', { name: 'Delete Books' })).toBeDisabled();

  await page.getByLabel(`Name of ${name}`).fill(`${name} & Games`);
  await page
    .locator('li', { has: page.getByLabel(`Name of ${name}`) })
    .getByRole('button', { name: 'Save' })
    .click();
  const renamed = `${name} & Games`;
  await expect(page.getByLabel(`Name of ${renamed}`)).toBeVisible();

  await page.getByRole('button', { name: `Move ${renamed} up` }).click();
  const names = page.locator('.category-list input[name=name]');
  await expect.poll(async () => (await names.evaluateAll((els) => els.map((e) => e.value))).at(-2)).toBe(renamed);

  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Categories' }).getByRole('link', { name: renamed })).toBeVisible();

  await page.goto('/admin/categories');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: `Delete ${renamed}` }).click();
  await expect(page.getByLabel(`Name of ${renamed}`)).toHaveCount(0);
});

test('the dashboard shows sales, best sellers and orders to ship', async ({ page, request }) => {
  const { order } = await customerOrder(request);
  await logIn(page, ADMIN);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveClass(/active/);
  await expect(page.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true');

  // The order just placed counts today, so revenue and the best sellers aren't empty.
  await expect(page.getByRole('region', { name: 'Totals' }).locator('.stat-value').first()).not.toHaveText('₹0');
  await expect(
    page.getByRole('region', { name: 'Best sellers' }).getByRole('link', { name: order.items[0].title }),
  ).toBeVisible();
  await page.getByText('Show as a table').click();
  await expect(page.getByRole('region', { name: 'Revenue per day' }).getByRole('row')).toHaveCount(31);

  await page.getByRole('button', { name: 'Last 7 days' }).click();
  await expect(page).toHaveURL(/\/admin\?days=7$/);
  await expect(page.getByRole('region', { name: 'Revenue per day' }).getByRole('row')).toHaveCount(8);

  // Sold-out sample products are listed as low stock.
  await expect(page.getByRole('region', { name: 'Needs attention' }).getByText('Sold out').first()).toBeVisible();

  // Export: the CSV for the period downloads with the new order in it.
  const exportForm = page.getByRole('form', { name: 'Export orders' });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportForm.getByRole('button', { name: 'Download CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^orders-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
  const file = (await readFile(await download.path(), 'utf8')).replace(/^\uFEFF/, '');
  expect(file.split('\r\n')[0]).toMatch(/^Order,Date \(India time\),Status,/);
  expect(file).toContain(`${order.number},`);

  await page.getByRole('link', { name: /orders? to ship/ }).click();
  await expect(page).toHaveURL(/\/admin\/orders\?status=placed/);
});

test('admin pages fit a phone screen without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await logIn(page, ADMIN, '/admin/products');
  await expect(page.locator('.admin-table tbody tr').first()).toBeVisible();
  // Only the table may scroll sideways (inside its own box), never the page.
  for (const path of [
    '/admin?days=90',
    '/admin/products',
    '/admin/orders',
    '/admin/categories',
    '/admin/reviews',
    '/admin/coupons',
    '/admin/returns?status=all',
    '/admin/exchanges?status=all',
    '/admin/collections',
    '/admin/purchase-orders/new?suggested=1',
    '/admin/delivery',
    '/admin/stocktakes/new',
    '/admin/products/new',
  ]) {
    await page.goto(path);
    // A wide font (Verdana on macOS, DejaVu Sans on CI's Linux), so text that only just fits on one system
    // doesn't pass here and fail on the other.
    await page.addStyleTag({ content: "* { font-family: Verdana, 'DejaVu Sans', sans-serif !important; }" });
    await expect(page.locator('.panel').first()).toBeVisible();
    expect(await page.locator('html').evaluate((html) => html.scrollWidth), path).toBeLessThanOrEqual(390);
  }

  // A product with variants: its table of sizes scrolls inside its own box.
  const { items } = await (await page.request.get('/api/admin/products?q=kurta')).json();
  await page.goto(`/admin/products/${items[0].id}`);
  await expect(page.getByLabel('Label of variant 1')).toBeVisible();
  expect(await page.locator('html').evaluate((html) => html.scrollWidth)).toBeLessThanOrEqual(390);
});

test('the morning low-stock email can be switched off and on from the dashboard', async ({ page }) => {
  await logIn(page, ADMIN);
  const toggle = page.getByRole('checkbox', { name: 'Email these lists to admins each morning' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await page.reload();
  await expect(toggle).not.toBeChecked();
  // Back on, for the other tests sharing this demo server.
  await toggle.click();
  await expect(toggle).toBeEnabled();
  await page.reload();
  await expect(toggle).toBeChecked();
});

test('the activity log shows what admins changed, filtered by area', async ({ page }) => {
  await logIn(page, ADMIN);
  // Two changes that leave things as they were: the morning email off, then on again.
  const toggle = page.getByRole('checkbox', { name: 'Email these lists to admins each morning' });
  await toggle.click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();

  await page.getByRole('link', { name: 'Activity' }).click();
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
  await page.getByLabel('Area').selectOption('settings');
  await expect(page).toHaveURL(/\/admin\/activity\?area=settings$/);
  const entries = page.locator('.activity-entry');
  await expect(entries.first()).toContainText('Switched on the low-stock email');
  await expect(entries.nth(1)).toContainText('Switched off the low-stock email');
  await expect(entries.first()).toContainText('Settings');

  // Products changed by earlier tests in this file are there too, with a link to each.
  await page.getByLabel('Area').selectOption('products');
  await expect(entries.first().getByRole('link')).toHaveAttribute('href', /^\/admin\/products\/[0-9a-f]{24}$/);
});

test('the dashboard downloads a GST summary by place of supply and rate', async ({ page }) => {
  await logIn(page, ADMIN);
  const exportForm = page.getByRole('form', { name: 'Export orders' });
  await exportForm.getByLabel('Report').selectOption('gst');
  await expect(exportForm.getByLabel('Status')).toBeDisabled();
  await expect(exportForm).toContainText('For the GST return');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportForm.getByRole('button', { name: 'Download CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^gst-summary-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
  const file = (await readFile(await download.path(), 'utf8')).replace(/^\uFEFF/, '');
  expect(file.split('\r\n')[0]).toBe(
    'Place of supply,State code,GST rate (%),Orders,Credit notes,Taxable value (₹),CGST (₹),SGST (₹),IGST (₹),Total tax (₹)',
  );
});

test('the dashboard shows how full the database is', async ({ page }) => {
  await logIn(page, ADMIN);
  const storage = page.getByRole('region', { name: 'Storage' });
  await expect(storage).toContainText(/[\d.]+ (KB|MB) of 512\.0 MB used \([\d.]+%\)/);
  await expect(storage.getByRole('meter', { name: 'Database storage used' })).toBeVisible();
  await expect(storage).toContainText('Biggest:');
});
