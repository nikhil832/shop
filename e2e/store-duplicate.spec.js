import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// The copy is made hidden; the test shows it to check the store page, then hides it again for the other specs.
test('an admin duplicates a product into a hidden copy, edits it and shows it', async ({ page }) => {
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const bag = await (await page.request.get('/api/products/ziva-women-handbag')).json();
  await page.goto(`/admin/products/${bag.id}`);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Duplicate' }).click();

  await expect(page.getByRole('status')).toContainText(`A copy of “${bag.title}”, hidden from the store`);
  await expect(page.getByLabel('Title')).toHaveValue(`${bag.title} (copy)`);
  await expect(page.getByLabel('Show in store')).not.toBeChecked();
  const id = page.url().split('/').pop();
  expect(id).not.toBe(bag.id);
  // Its colours came along with their prices, at no stock.
  await expect(page.getByLabel('Label of variant 1')).toHaveValue(bag.variants[0].label);
  await expect(page.getByLabel('Price of variant 1')).toHaveValue(String(bag.variants[0].price / 100));
  await expect(page.getByLabel('Stock of variant 1')).toHaveValue('0');

  const stamp = Date.now().toString(36);
  const title = `Ziva Weekender Bag ${stamp}`;
  try {
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Stock of variant 1').fill('4');
    await page.getByLabel('Show in store').check();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toContainText(`Saved “${title}”.`);

    // Renamed before it was first shown, so its address comes from the new title; the original is unchanged.
    await page.goto(`/p/ziva-weekender-bag-${stamp}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    await page.goto('/p/ziva-women-handbag');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(bag.title);
  } finally {
    await page.request.patch(`/api/admin/products/${id}`, { data: { active: false } });
  }
});
