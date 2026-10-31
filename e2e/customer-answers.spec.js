import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const address = {
  name: 'Ravi Kumar',
  phone: '9123456780',
  line1: '1 Lake Road',
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411001',
};

// Its own product (hidden again at the end): one customer asks, another who bought it answers, an admin hides it.
test('buyers answer other customers’ questions; admins can hide an answer', async ({ page, browser }) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await admin.request.get('/api/categories')).json();
  const title = `Kitwell Flask ${Date.now().toString(36)}`;
  const product = await (
    await admin.request.post('/api/admin/products', {
      data: { title, brand: 'Kitwell', categoryId: category.id, price: 59900, mrp: 69900, stock: 10 },
    })
  ).json();
  try {
    // The buyer (this page) orders it and the admin delivers it.
    await page.request.post('/api/auth/register', {
      data: { name: 'Ravi Kumar', email: `buyer-${Date.now()}@example.com`, password: 'password123' },
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
    // Another customer asks.
    const asker = await (await browser.newContext()).newPage();
    await asker.request.post('/api/auth/register', {
      data: { name: 'Meera Iyer', email: `asker-${Date.now()}@example.com`, password: 'password123' },
    });
    const question = 'Does it keep tea hot all day?';
    expect(
      (await asker.request.post(`/api/products/${product.slug}/questions`, { data: { text: question } })).ok(),
    ).toBe(true);

    await page.goto(`/p/${product.slug}#questions`);
    const help = page.getByRole('region', { name: 'Can you help?' });
    const form = help.getByRole('form', { name: `Answer: ${question}` });
    await form.getByLabel('Your answer').fill('About eight hours in my experience.');
    await form.getByRole('button', { name: 'Post answer' }).click();
    await expect(help).toHaveCount(0);
    const qa = page.locator('#questions .review-list > li').filter({ hasText: question });
    await expect(qa).toContainText('About eight hours in my experience.');
    await expect(qa).toContainText('Ravi K.');
    await expect(qa.getByText('Bought this')).toBeVisible();
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      expect(
        (await new AxeBuilder({ page }).include('#questions').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      ).toEqual([]);
    }

    // The asker's question is answered now, so it's no longer "waiting" for them.
    await asker.goto(`/p/${product.slug}#questions`);
    await expect(asker.getByText('About eight hours in my experience.')).toBeVisible();
    await expect(asker.getByRole('heading', { name: /waiting for an answer/ })).toHaveCount(0);

    // An admin hides the answer: the question leaves the product page, as nobody else answered it.
    await admin.goto('/admin/questions');
    const card = admin.locator('li.question-card').filter({ hasText: question });
    await card.getByRole('button', { name: "Hide Ravi K.'s answer" }).click();
    await expect(card.getByRole('button', { name: "Show Ravi K.'s answer" })).toBeVisible();
    await page.reload();
    await expect(page.getByText(question)).toHaveCount(0);
  } finally {
    await admin.request.patch(`/api/admin/products/${product.id}`, { data: { active: false } });
  }
});
