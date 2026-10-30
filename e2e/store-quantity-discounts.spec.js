import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Named to run after catalog.spec.js: it adds a product (hidden again at the end), so no other spec's prices change.
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test('an admin offers 10% off from 3; the product page and cart show it, and it applies at 3', async ({
  page,
  browser,
}) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const categories = await (await admin.request.get('/api/categories')).json();
  const books = categories.find((c) => c.slug === 'books');
  const title = `Pocket Diary ${unique()}`;
  const diary = await (
    await admin.request.post('/api/admin/products', {
      data: { title, brand: 'Kagaz', categoryId: books.id, price: 34900, mrp: 39900, stock: 20 },
    })
  ).json();
  try {
    // The offer is set in the product form.
    await admin.goto(`/admin/products/${diary.id}`);
    const offer = admin.getByRole('group', { name: 'Quantity discount (optional)' });
    await offer.getByLabel('From how many').fill('3');
    await offer.getByLabel('Percent off each').fill('10');
    await admin.getByRole('button', { name: 'Save' }).click();
    await expect(admin).toHaveURL('/admin/products');

    await page.goto(`/p/${diary.slug}`);
    await expect(page.getByText('Buy 3 or more, 10% off each')).toBeVisible();
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await page.goto('/cart');
    await page.getByLabel(`Quantity of ${title}`).selectOption('2');
    await expect(page.getByText('Add 1 more for 10% off each')).toBeVisible();

    await page.getByLabel(`Quantity of ${title}`).selectOption('3');
    await expect(page.getByText('10% off for 3 or more: ₹315 each')).toBeVisible();
    const summary = page.getByRole('complementary', { name: 'Order summary' });
    await expect(summary).toContainText('Quantity discounts');
    await expect(summary).toContainText('−₹102');
    await expect(summary).toContainText('₹945'); // 3 × ₹315, free delivery
    // The green notes are readable in both themes.
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      expect(
        (await new AxeBuilder({ page }).include('.cart-page').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
        colorScheme,
      ).toEqual([]);
    }
  } finally {
    await admin.request.patch(`/api/admin/products/${diary.id}`, { data: { active: false } });
  }
});
