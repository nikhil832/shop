import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const address = {
  name: 'Farah Khan',
  phone: '9123456783',
  line1: '22 Park Street',
  city: 'Kolkata',
  state: 'West Bengal',
  pincode: '700016',
};

// Its own gift product; the offer is switched off and the product hidden at the end, as every spec shares the server.
test('a free gift with orders over an amount: offered in the cart, added to the order', async ({ page, browser }) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await admin.request.get('/api/categories')).json();
  const title = `Kitwell Tote ${Date.now().toString(36)}`;
  const gift = await (
    await admin.request.post('/api/admin/products', {
      data: { title, brand: 'Kitwell', categoryId: category.id, price: 19900, mrp: 24900, stock: 5 },
    })
  ).json();
  try {
    await admin.goto('/admin/coupons');
    const form = admin.getByRole('form', { name: 'Free gift' });
    await form.getByLabel('Give a free gift').check();
    await form.getByRole('combobox', { name: 'Gift' }).selectOption({ label: `${title} (5 in stock)` });
    await form.getByLabel('For orders from (₹)').fill('500');
    await form.getByRole('button', { name: 'Save free gift' }).click();
    await expect(form.getByRole('status')).toHaveText('Saved.');
    await expect(form).toContainText('On now, 5 left.');

    // ₹349 in the cart: ₹151 to go.
    await page.goto('/p/the-quiet-engineer-paperback');
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await page.goto('/cart');
    const summary = page.getByRole('complementary', { name: 'Order summary' });
    await expect(summary.locator('.free-gift-note')).toHaveText(`Add ₹151 more for a free ${title}.`);
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      expect(
        (await new AxeBuilder({ page }).include('.free-gift-note').withTags(['wcag2a', 'wcag2aa']).analyze())
          .violations,
      ).toEqual([]);
    }
    // Two copies: ₹698, so it comes with the order.
    await page.goto('/p/the-quiet-engineer-paperback');
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await page.goto('/cart');
    await expect(summary.locator('.free-gift-note')).toHaveText(`Free gift: ${title} comes with this order.`);

    // An order over the amount has it as a free line.
    await page.request.post('/api/auth/register', {
      data: { name: 'Farah Khan', email: `gift-${Date.now()}@example.com`, password: 'password123' },
    });
    const { items } = await (await page.request.get('/api/products?q=quiet%20engineer')).json();
    const quote = await (await page.request.get(`/api/cart?items=${items[0].id}:2`)).json();
    const order = await (
      await page.request.post('/api/orders', {
        data: { items: [{ productId: items[0].id, qty: 2 }], address, expectedTotal: quote.total },
      })
    ).json();
    await page.goto(`/orders/${order.id}`);
    await expect(page.getByText(`${title} (free gift)`)).toBeVisible();
    await expect(page.getByText('Free with your order (worth ₹199)')).toBeVisible();
  } finally {
    await admin.request.put('/api/admin/free-gift', {
      data: { enabled: false, productId: null, minSubtotal: 99900, from: null, to: null },
    });
    await admin.request.patch(`/api/admin/products/${gift.id}`, { data: { active: false } });
  }
});
