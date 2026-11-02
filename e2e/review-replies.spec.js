import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const address = {
  name: 'Nisha Menon',
  phone: '9123456782',
  line1: '7 Marine Drive',
  city: 'Kochi',
  state: 'Kerala',
  pincode: '682001',
};

// Its own product (hidden again at the end), so the low rating doesn't move any product other specs look at.
test('the store replies to a low review from Admin → Reviews, and shoppers see the reply', async ({
  page,
  browser,
}) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await admin.request.get('/api/categories')).json();
  const stamp = Date.now().toString(36);
  const product = await (
    await admin.request.post('/api/admin/products', {
      data: {
        title: `Kitwell Mug ${stamp}`,
        brand: 'Kitwell',
        categoryId: category.id,
        price: 29900,
        mrp: 34900,
        stock: 10,
      },
    })
  ).json();
  let reviewId = null;
  try {
    await page.request.post('/api/auth/register', {
      data: { name: 'Nisha Menon', email: `reply-${stamp}@example.com`, password: 'password123' },
    });
    const quote = await (await page.request.get(`/api/cart?items=${product.id}:1`)).json();
    const order = await (
      await page.request.post('/api/orders', {
        data: { items: [{ productId: product.id, qty: 1 }], address, expectedTotal: quote.total },
      })
    ).json();
    for (const status of ['shipped', 'delivered']) {
      expect((await admin.request.post(`/api/admin/orders/${order.id}/status`, { data: { status } })).ok()).toBe(true);
    }
    const body = `The handle came off on day two ${stamp}`;
    const saved = await page.request.put(`/api/products/${product.slug}/review`, {
      data: { rating: 1, title: 'Broke quickly', body },
    });
    expect(saved.ok()).toBe(true);
    reviewId = (await saved.json()).id;

    // It's waiting under "Needs a reply"; the admin replies from there.
    await admin.goto('/admin/reviews?status=reply');
    await expect(admin.getByRole('button', { name: /^Needs a reply/ })).toHaveAttribute('aria-pressed', 'true');
    const row = admin.getByRole('row').filter({ hasText: body });
    await row.getByText('Reply', { exact: true }).click();
    const form = row.getByRole('form', { name: "Reply to Nisha Menon's review" });
    await form.getByLabel('Reply to Nisha Menon').fill('So sorry! We are sending you a new mug today.');
    await form.getByRole('button', { name: 'Save reply' }).click();
    // Replied, so it leaves the list.
    await expect(admin.getByRole('row').filter({ hasText: body })).toHaveCount(0);
    await admin.goto('/admin/reviews');
    const replied = admin.getByRole('row').filter({ hasText: body });
    await expect(replied).toContainText('Your reply');
    await expect(replied).toContainText('So sorry! We are sending you a new mug today.');

    // Shoppers see it under the review, signed by the store.
    const shopper = await (await browser.newContext()).newPage();
    await shopper.goto(`/p/${product.slug}#reviews`);
    const review = shopper.locator('#reviews .review-list > li').filter({ hasText: body });
    await expect(review.locator('.review-reply')).toContainText('Reply from Bazaar');
    await expect(review.locator('.review-reply')).toContainText('So sorry! We are sending you a new mug today.');
    for (const colorScheme of ['light', 'dark']) {
      await shopper.emulateMedia({ colorScheme });
      expect(
        (await new AxeBuilder({ page: shopper }).include('#reviews').withTags(['wcag2a', 'wcag2aa']).analyze())
          .violations,
      ).toEqual([]);
    }

    // The admin removes the reply again.
    await admin.goto('/admin/reviews');
    const again = admin.getByRole('row').filter({ hasText: body });
    await again.getByText('Edit reply', { exact: true }).click();
    admin.once('dialog', (d) => d.accept());
    await again.getByRole('button', { name: 'Remove reply' }).click();
    await expect(again).not.toContainText('Your reply');
  } finally {
    // Hidden, so it doesn't wait under "Needs a reply" for the other specs' admins.
    if (reviewId) await admin.request.post(`/api/admin/reviews/${reviewId}/visibility`, { data: { hidden: true } });
    await admin.request.patch(`/api/admin/products/${product.id}`, { data: { active: false } });
  }
});
