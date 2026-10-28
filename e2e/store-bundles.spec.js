import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const FORM = {
  'Mobile number': '9123456780',
  'Address (house, street, area)': '12 Hill Road',
  City: 'Pune',
  State: 'Maharashtra',
  'PIN code': '411001',
};

// Its own two products, and the bundle switched off at the end: bundles apply to any cart on this shared server.
test('an admin bundles two products; a shopper adds the bundle and pays the bundle price', async ({
  page,
  browser,
}) => {
  const stamp = Date.now().toString(36);
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await admin.request.get('/api/categories')).json();
  const make = async (title, price) =>
    (
      await admin.request.post('/api/admin/products', {
        data: { title, brand: 'Griha', categoryId: category.id, price, mrp: price + 20000, stock: 20 },
      })
    ).json();
  const mixer = await make(`Spice Mixer ${stamp}`, 299900);
  const jar = await make(`Extra Jar ${stamp}`, 79900);

  await admin.goto('/admin/bundles');
  const form = admin.getByRole('form', { name: 'New bundle' });
  await form.getByLabel('Name').fill(`Mixer + jar ${stamp}`);
  for (const p of [mixer, jar]) {
    await form.getByLabel('Find products').fill(stamp);
    await form.getByRole('button', { name: `Add ${p.title}` }).click();
  }
  await expect(form.getByText('· ₹3,798 apart')).toBeVisible();
  await form.getByLabel(/^Bundle price/).fill('3499');
  await form.getByRole('button', { name: 'Add bundle' }).click();
  await expect(admin.getByRole('status')).toHaveText(`“Mixer + jar ${stamp}” added.`);
  const row = admin.getByRole('row').filter({ hasText: `Mixer + jar ${stamp}` });
  await expect(row).toContainText('saves ₹299');

  try {
    await page.request.post('/api/auth/register', {
      data: { name: 'Asha Rao', email: `bundle-${stamp}@example.com`, password: 'password123' },
    });
    await page.goto(`/p/${jar.slug}`);
    const offers = page.getByRole('region', { name: 'Buy together and save' });
    await expect(offers).toContainText('₹3,499 for all 2');
    await expect(offers).toContainText('save ₹299');
    expect(
      (await new AxeBuilder({ page }).include('.bundle-offers').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    ).toEqual([]);
    await offers.getByRole('button', { name: /^Add bundle/ }).click();
    await offers.getByRole('link', { name: 'Go to cart' }).click();

    const summary = page.getByRole('complementary', { name: 'Order summary' });
    await expect(summary).toContainText(`Bundle savings`);
    await expect(summary).toContainText('−₹299');
    await page.goto('/checkout');
    for (const [label, value] of Object.entries(FORM)) await page.getByLabel(label).fill(value);
    await page.getByRole('radio', { name: /Cash on Delivery/ }).check();
    await page.getByRole('button', { name: 'Place order · ₹3,499' }).click();
    await expect(page.getByText(`In the “Mixer + jar ${stamp}” bundle`).first()).toBeVisible();
  } finally {
    await row.getByRole('button', { name: /^Switch off/ }).click();
    await expect(row).toContainText('Off');
  }
});
