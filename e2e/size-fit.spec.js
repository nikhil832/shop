import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Size fit from reviews (stage 137), on its own product with sizes (hidden again at the end), as every spec shares one
// demo server.
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const address = {
  name: 'Kavya Menon',
  phone: '9123456780',
  line1: '7 Marine Drive',
  city: 'Kochi',
  state: 'Kerala',
  pincode: '682001',
};

test('buyers say how it fits, and the product page shows what most say', async ({ page, browser }) => {
  const stamp = Date.now().toString(36);
  const admin = (await browser.newContext()).request;
  expect((await admin.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const fashion = (await (await admin.get('/api/categories')).json()).find((c) => c.slug === 'fashion');
  const size = (label) => ({ label, price: 39900, mrp: 59900, stock: 20 });
  const created = await admin.post('/api/admin/products', {
    data: {
      title: `Kitwell Tee ${stamp}`,
      brand: 'Kitwell',
      categoryId: fashion.id,
      variantName: 'Size',
      variants: [size('M'), size('L')],
    },
  });
  expect(created.ok()).toBe(true);
  const { id: productId, slug } = await created.json();

  // A customer (in `api`'s cookie jar) whose order of size M was delivered.
  async function buyer(api, n) {
    const email = `fit-${stamp}-${n}@example.com`;
    expect((await api.post('/api/auth/register', { data: { name: `Kavya ${n}`, email, password: 'pass1234' } })).ok());
    const product = await (await api.get(`/api/products/${slug}`)).json();
    const variantId = product.variants.find((v) => v.label === 'M').id;
    const quote = await (await api.get(`/api/cart?items=${product.id}.${variantId}:1`)).json();
    const order = await api.post('/api/orders', {
      data: { items: [{ productId, variantId, qty: 1 }], address, expectedTotal: quote.total },
    });
    expect(order.status(), await order.text()).toBe(201);
    const { id } = await order.json();
    for (const status of ['shipped', 'delivered']) {
      expect((await admin.post(`/api/admin/orders/${id}/status`, { data: { status } })).ok()).toBe(true);
    }
  }

  try {
    // Two earlier buyers say true to size.
    for (const n of [1, 2]) {
      const api = (await browser.newContext()).request;
      await buyer(api, n);
      expect((await api.put(`/api/products/${slug}/review`, { data: { rating: 5, fit: 'true' } })).ok()).toBe(true);
    }
    await page.goto(`/p/${slug}`);
    await expect(page.getByRole('heading', { name: `Kitwell Tee ${stamp}`, level: 1 })).toBeVisible();
    await expect(page.locator('.size-fit')).toHaveCount(0); // two answers aren't enough

    // A third reviews in the browser and says it runs small.
    await buyer(page.request, 3);
    await page.reload();
    const form = page.locator('form.review-form').filter({ hasText: 'Your rating' });
    const fit = form.getByRole('group', { name: 'How does it fit? (optional)' });
    await expect(fit).toBeVisible();
    expect((await new AxeBuilder({ page }).include('form.review-form').analyze()).violations).toEqual([]);
    await form.getByRole('radio', { name: '4 stars', exact: true }).locator('..').click();
    await fit.getByLabel('Runs small').check();
    await form.getByRole('button', { name: 'Post review' }).click();
    await expect(page.getByText('Fit: runs small').first()).toBeVisible();

    await page.reload();
    await expect(page.locator('.size-fit')).toHaveText('Most say: true to size (2 of 3 reviews)');
  } finally {
    await admin.patch(`/api/admin/products/${productId}`, { data: { active: false } });
  }
});
