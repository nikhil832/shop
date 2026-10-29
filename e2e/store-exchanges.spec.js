import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// Its own product with sizes (hidden again at the end), so other specs' stock counts don't move.
test('a customer swaps a size; the admin approves it once it is back, ships the new one and marks it delivered', async ({
  page,
  browser,
}) => {
  const stamp = Date.now().toString(36);
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const categories = await (await admin.request.get('/api/categories')).json();
  const fashion = categories.find((c) => c.slug === 'fashion');
  const size = (label, price, stock) => ({ label, price, mrp: 99900, stock });
  const created = await admin.request.post('/api/admin/products', {
    data: {
      title: `Trail Socks ${stamp}`,
      brand: 'Stride',
      categoryId: fashion.id,
      variantName: 'Size',
      variants: [size('S', 49900, 6), size('M', 49900, 6), size('L', 49900, 0), size('XL', 59900, 6)],
    },
  });
  expect(created.ok()).toBe(true);
  const { id: productId, slug } = await created.json();

  try {
    const product = await (await page.request.get(`/api/products/${slug}`)).json();
    const sizeId = (label) => product.variants.find((v) => v.label === label).id;
    expect(
      (
        await page.request.post('/api/auth/register', {
          data: { name: 'Kavya Nair', email: `exchange-${stamp}@example.com`, password: 'password123' },
        })
      ).ok(),
    ).toBe(true);
    const quote = await (await page.request.get(`/api/cart?items=${productId}.${sizeId('M')}:1`)).json();
    const order = await (
      await page.request.post('/api/orders', {
        data: {
          items: [{ productId, variantId: sizeId('M'), qty: 1 }],
          address: {
            name: 'Kavya Nair',
            phone: '9123456780',
            line1: '7 Beach Road',
            city: 'Kochi',
            state: 'Kerala',
            pincode: '682001',
          },
          expectedTotal: quote.total,
        },
      })
    ).json();
    for (const status of ['shipped', 'delivered']) {
      expect((await admin.request.post(`/api/admin/orders/${order.id}/status`, { data: { status } })).ok()).toBe(true);
    }

    await page.goto(`/orders/${order.id}`);
    const section = page.getByRole('region', { name: 'Returns and exchanges' });
    await section.getByRole('link', { name: 'Exchange for another size or colour' }).click();
    await expect(page.getByRole('heading', { name: 'Exchange items' })).toBeVisible();
    // Fits a phone without sideways scrolling.
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator('html').evaluate((html) => html.scrollWidth)).toBeLessThanOrEqual(390);
    const instead = page.getByLabel(`What you'd like instead of Trail Socks ${stamp} (Size: M)`);
    // Same price only (not XL), the sold-out size can't be chosen.
    await expect(instead.locator('option')).toHaveText(['Keep this one', 'S', 'L (sold out)']);
    await expect(instead.locator('option', { hasText: 'L (sold out)' })).toHaveAttribute('disabled', '');
    await expect(page.getByRole('button', { name: 'Ask to exchange' })).toBeDisabled();
    await instead.selectOption({ label: 'S' });
    await page.getByLabel('Reason').selectOption({ label: "Doesn't fit" });
    await page.getByRole('button', { name: 'Ask to exchange' }).click();

    await expect(page).toHaveURL(`/orders/${order.id}`);
    await expect(page.getByRole('status').first()).toContainText('Exchange requested');
    await expect(section).toContainText(`Trail Socks ${stamp}, M → S × 1`);
    await expect(section).toContainText('Waiting for review');
    // The item can't be exchanged or returned twice.
    await expect(section.getByRole('link', { name: /Exchange for another/ })).toHaveCount(0);
    await expect(section.getByRole('link', { name: 'Return items' })).toHaveCount(0);

    // The admin approves it once the socks are back, then ships the new size with tracking.
    await admin.goto('/admin/exchanges');
    const row = admin.getByRole('row', { name: new RegExp(`#${order.number}`) });
    await expect(row).toContainText('M → S × 1');
    await expect(row).toContainText("Doesn't fit");
    admin.once('dialog', (d) => d.accept());
    await row.getByRole('button', { name: /^Approve/ }).click();
    await expect(row).toHaveCount(0);
    await admin.getByRole('button', { name: /^To ship/ }).click();
    const toShip = admin.getByRole('row', { name: new RegExp(`#${order.number}`) });
    await toShip.getByRole('button', { name: /^Ship new item/ }).click();
    await toShip.getByLabel('Courier', { exact: true }).fill('Delhivery');
    await toShip.getByLabel('Tracking number', { exact: true }).fill(`EX${stamp}`.toUpperCase());
    await toShip.getByRole('button', { name: 'Mark as shipped' }).click();
    await expect(toShip).toHaveCount(0);
    await admin.getByRole('button', { name: /^Shipped/ }).click();
    const shipped = admin.getByRole('row', { name: new RegExp(`#${order.number}`) });
    await expect(shipped).toContainText(`Delhivery EX${stamp.toUpperCase()}`);
    await shipped.getByRole('button', { name: /^Mark delivered/ }).click();
    await expect(shipped).toHaveCount(0);

    // M came back, S went out; the order itself is unchanged.
    const after = await (await page.request.get(`/api/products/${slug}`)).json();
    const stock = (label) => after.variants.find((v) => v.label === label).stock;
    expect([stock('S'), stock('M')]).toEqual([5, 6]);
    await page.reload();
    await expect(section).toContainText('New item delivered');
    await expect(page.getByRole('heading', { name: `Order #${order.number}` })).toBeVisible();

    // The admin's order page lists it.
    await admin.goto(`/admin/orders/${order.id}`);
    await expect(admin.getByRole('region', { name: 'Exchanges' })).toContainText('M → S × 1');
  } finally {
    await admin.request.patch(`/api/admin/products/${productId}`, { data: { active: false } });
  }
});
