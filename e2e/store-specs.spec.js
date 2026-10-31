import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// Its own two products (hidden again at the end), so other specs' pages and comparisons are unaffected.
test('an admin types specifications; the product page lists them and Compare lines them up', async ({
  page,
  browser,
}) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const categories = await (await admin.request.get('/api/categories')).json();
  const laptops = categories.find((c) => c.slug === 'laptops');
  const stamp = Date.now().toString(36);
  const create = async (title, specs) => {
    const res = await admin.request.post('/api/admin/products', {
      data: { title, brand: 'Kitwell', categoryId: laptops.id, price: 4999900, mrp: 5999900, stock: 5, specs },
    });
    expect(res.status()).toBe(201);
    return res.json();
  };
  const one = await create(`Kitwell Book ${stamp}`, []);
  const two = await create(`Kitwell Book Plus ${stamp}`, [
    { name: 'RAM', value: '32 GB' },
    { name: 'Weight', value: '1.6 kg' },
  ]);
  try {
    await admin.goto(`/admin/products/${one.id}`);
    const box = admin.getByLabel('Specifications (one per line as Name: Value, up to 20)');
    await box.fill('RAM: 16 GB\nStorage 512 GB');
    await admin.getByRole('button', { name: 'Save changes' }).click();
    await expect(admin.getByRole('alert')).toHaveText('Specifications: write “Storage 512 GB” as Name: Value');
    await box.fill('RAM: 16 GB\nStorage: 512 GB SSD\nBattery life: up to 12:30 hours');
    await admin.getByRole('button', { name: 'Save changes' }).click();
    await expect(admin.getByRole('status')).toContainText(`Saved “Kitwell Book ${stamp}”.`);

    await page.goto(`/p/${one.slug}`);
    const table = page.getByRole('table');
    await expect(table.getByRole('row')).toHaveText([
      'RAM16 GB',
      'StorageSSD'.replace('SSD', '512 GB SSD'),
      'Battery lifeup to 12:30 hours',
    ]);
    expect(
      (await new AxeBuilder({ page }).include('.specs-table').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    ).toEqual([]);

    // Side by side: each name once, in the order it first appears, with "—" where one has none.
    await page.goto(`/compare?slugs=${one.slug},${two.slug}`);
    const row = (name) => page.getByRole('row', { name: new RegExp(`^${name}`) });
    await expect(row('RAM')).toContainText('16 GB');
    await expect(row('RAM')).toContainText('32 GB');
    await expect(row('Storage')).toContainText('512 GB SSD');
    await expect(row('Storage')).toContainText('—');
    await expect(row('Weight')).toContainText('1.6 kg');
  } finally {
    for (const p of [one, two]) await admin.request.patch(`/api/admin/products/${p.id}`, { data: { active: false } });
  }
});
