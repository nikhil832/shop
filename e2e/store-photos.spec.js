import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test('photos uploaded before small versions get them from the products page', async ({ page }) => {
  const api = page.request;
  expect((await api.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  // A product whose photo was uploaded the old way (straight to the API, no small version).
  const { url } = await (
    await api.post('/api/admin/images', { headers: { 'Content-Type': 'image/png' }, data: PNG })
  ).json();
  const [category] = await (await api.get('/api/categories')).json();
  await api.post('/api/admin/products', {
    data: {
      title: `Old Photo Lamp ${Date.now()}`,
      brand: 'Griha',
      categoryId: category.id,
      price: 99900,
      mrp: 99900,
      stock: 3,
      images: [url],
    },
  });
  const before = await api.get(`${url}?size=small`);
  expect(before.headers()['content-type']).toBe('image/png'); // the photo itself, for now

  await page.goto('/admin/products');
  await page.getByRole('button', { name: 'Make small versions' }).click();
  await expect(page.getByRole('status')).toContainText(/Made \d+ small versions?/);
  expect((await (await api.get('/api/admin/images/without-small')).json()).urls).toEqual([]);
  const after = await api.get(`${url}?size=small`);
  expect(after.headers()['content-type']).toBe('image/jpeg');
  expect(after.headers()['cache-control']).toContain('immutable');
});
