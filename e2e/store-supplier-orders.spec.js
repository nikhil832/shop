import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// Its own product (hidden again at the end), so other specs' stock counts don't move.
test('an admin orders from a supplier, receives part of it against the order, and closes it short', async ({
  page,
}) => {
  const stamp = Date.now().toString(36);
  const title = `Brass Diya ${stamp}`;
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const categories = await (await page.request.get('/api/categories')).json();
  const product = await (
    await page.request.post('/api/admin/products', {
      data: { title, brand: 'Griha', categoryId: categories[0].id, price: 49900, mrp: 59900, stock: 2 },
    })
  ).json();

  try {
    await page.goto('/admin/purchase-orders');
    await page.getByRole('link', { name: 'New supplier order' }).click();
    const form = page.getByRole('form', { name: 'New supplier order' });
    await form.getByLabel('Supplier', { exact: true }).fill(`Deepam Crafts ${stamp}`);
    await form.getByLabel('Add a product').fill(stamp);
    await form.getByRole('button', { name: `Add ${title}` }).click();
    await form.getByLabel('Order of line 1').fill('8');
    await form.getByLabel('Price each of line 1').fill('150');
    await expect(form.getByText('Total: ₹1,200')).toBeVisible();
    await form.getByRole('button', { name: 'Make the order' }).click();

    await expect(page.getByRole('heading', { name: /^Supplier order #\d+$/ })).toBeVisible();
    await expect(page.getByText(`To Deepam Crafts ${stamp}`)).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(title) })).toContainText('8 to come');
    await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
    const orderUrl = page.url();

    // Five arrive: the delivery form is filled in from the order.
    await page.getByRole('link', { name: 'Record a delivery' }).click();
    await expect(page.getByLabel('Supplier', { exact: true })).toHaveValue(`Deepam Crafts ${stamp}`);
    await expect(page.getByLabel('Received of line 1')).toHaveValue('8');
    await expect(page.getByLabel('Price each of line 1')).toHaveValue('150');
    await page.getByLabel('Received of line 1').fill('5');
    await page.getByRole('button', { name: 'Add to stock' }).click();
    await expect(page.getByRole('heading', { name: /^Delivery #\d+ from Deepam Crafts/ })).toBeVisible();
    await page.getByRole('link', { name: /^supplier order #\d+$/ }).click();
    await expect(page).toHaveURL(orderUrl);
    const row = page.getByRole('row', { name: new RegExp(title) });
    await expect(row).toContainText('3 to come');
    await expect(page.getByRole('link', { name: /^Delivery #\d+$/ })).toBeVisible();

    // The rest isn't coming.
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Close short' }).click();
    await expect(page.getByText('Closed short')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Record a delivery' })).toHaveCount(0);
    const after = await (await page.request.get(`/api/admin/products/${product.id}`)).json();
    expect(after.stock).toBe(7);
  } finally {
    await page.request.patch(`/api/admin/products/${product.id}`, { data: { active: false } });
  }
});
