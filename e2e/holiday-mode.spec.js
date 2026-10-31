import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const DAY = 86_400_000;
const day = (n) => new Date(Date.now() + 330 * 60_000 + n * DAY).toISOString().slice(0, 10);

// A break on the shared server would close every other spec's checkout, so it is always ended in `finally`.
test('a store holiday shows in the shop and can pause checkout', async ({ page, browser }) => {
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  try {
    await page.goto('/admin/delivery');
    const form = page.getByRole('form', { name: 'Holiday mode' });
    await form.getByLabel('First day away').fill(day(0));
    await form.getByLabel('Last day away').fill(day(1));
    await form.getByRole('radio', { name: /Pause orders/ }).check();
    await form.getByLabel('Message for the shop (optional)').fill('Happy Diwali from all of us!');
    await form.getByRole('button', { name: 'Set a holiday' }).click();
    await expect(form.getByRole('status')).toHaveText('Saved.');
    await expect(form.getByRole('button', { name: 'End the holiday' })).toBeVisible();

    const shopper = await (await browser.newContext()).newPage();
    const email = `holiday-${Date.now()}@example.com`;
    await shopper.request.post('/api/auth/register', { data: { name: 'Tara Sen', email, password: 'password123' } });
    await shopper.goto('/');
    const notice = shopper.getByRole('complementary', { name: 'Store holiday' });
    await expect(notice).toContainText("We're on a break until");
    await expect(notice).toContainText("We're not taking orders now");
    await expect(notice).toContainText('Happy Diwali from all of us!');
    expect(
      (await new AxeBuilder({ page: shopper }).include('.holiday-notice').withTags(['wcag2a', 'wcag2aa']).analyze())
        .violations,
    ).toEqual([]);

    await shopper.goto('/p/the-quiet-engineer-paperback');
    await shopper.getByRole('button', { name: 'Add to cart' }).click();
    await shopper.goto('/checkout');
    await expect(shopper.getByRole('alert').filter({ hasText: "We're on a break" })).toBeVisible();
    await expect(shopper.getByRole('button', { name: /^Place order/ })).toBeDisabled();

    // Ending it opens checkout again.
    page.once('dialog', (d) => d.accept());
    await form.getByRole('button', { name: 'End the holiday' }).click();
    await expect(form.getByRole('status')).toHaveText('Holiday ended.');
    await shopper.goto('/');
    await expect(shopper.getByRole('complementary', { name: 'Store holiday' })).toHaveCount(0);
  } finally {
    await page.request.delete('/api/admin/holiday');
  }
});
