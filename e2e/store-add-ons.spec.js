import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

// Its own products, hidden again at the end, so other specs' listings and carts aren't affected.
test('an admin picks add-ons; they show on the product page and in the cart with Add', async ({ page, browser }) => {
  const stamp = Date.now().toString(36);
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const [category] = await (await admin.request.get('/api/categories')).json();
  const create = async (title, price) => {
    const res = await admin.request.post('/api/admin/products', {
      data: { title, brand: 'Kitwell', categoryId: category.id, price, mrp: price + 10000, stock: 50 },
    });
    expect(res.status()).toBe(201);
    return res.json();
  };
  const phone = await create(`Kitwell Phone ${stamp}`, 999900);
  const caseTitle = `Kitwell Case ${stamp}`;
  const chargerTitle = `Kitwell Charger ${stamp}`;
  const made = [phone, await create(caseTitle, 29900), await create(chargerTitle, 79900)];
  try {
    await admin.goto(`/admin/products/${phone.id}`);
    const addOns = admin.getByRole('group', { name: 'Goes well with (optional)' });
    for (const title of [caseTitle, chargerTitle]) {
      await addOns.getByLabel('Find products').fill(title);
      await addOns.getByRole('button', { name: `Add ${title}`, exact: true }).click();
    }
    const chosen = addOns.getByRole('list', { name: 'Goes well with' });
    await chosen.getByRole('button', { name: `Up ${chargerTitle}` }).click();
    await expect(chosen.getByRole('listitem').first()).toContainText(chargerTitle);
    expect(
      (await new AxeBuilder({ page: admin }).include('.add-ons').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    ).toEqual([]);
    await admin.getByRole('button', { name: 'Save changes' }).click();
    await expect(admin).toHaveURL('/admin/products');

    // The product page lists them in the chosen order; "Add" puts one in the cart.
    await page.goto(`/p/${phone.slug}`);
    const row = page.getByRole('region', { name: 'Goes well with' });
    await expect(row.locator('.card-title')).toHaveText([chargerTitle, caseTitle]);
    expect(
      (await new AxeBuilder({ page }).include('.row-section').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    ).toEqual([]);
    await page.getByRole('button', { name: 'Add to cart', exact: true }).click();

    // The cart offers both; adding one moves it into the cart and out of the row.
    await page.goto('/cart');
    const cartRow = page.getByRole('region', { name: 'Goes well with your cart' });
    await expect(cartRow.locator('.card-title')).toHaveText([chargerTitle, caseTitle]);
    await cartRow.getByRole('button', { name: `Add ${caseTitle} to cart` }).click();
    await expect(page.locator('.cart-lines')).toContainText(caseTitle);
    await expect(cartRow.locator('.card-title')).toHaveText([chargerTitle]);

    // On a phone, cards scrolled out of a row don't widen the page (their Add buttons' hidden announcements once did).
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ['/cart', '/']) {
      await page.goto(path);
      await expect(page.locator('.row-section').first()).toBeVisible();
      expect(await page.locator('html').evaluate((html) => html.scrollWidth), path).toBeLessThanOrEqual(390);
    }
  } finally {
    for (const p of made) await admin.request.patch(`/api/admin/products/${p.id}`, { data: { active: false } });
  }
});
