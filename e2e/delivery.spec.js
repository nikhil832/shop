import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const BOOK = '/p/the-quiet-engineer-paperback';

test('an admin sets delivery areas; shoppers check their PIN code on the product page', async ({ page, browser }) => {
  await page.goto('/login?next=/admin/delivery');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Delivery', level: 1 })).toBeVisible();

  // Areas are shared with the other test files on this server: they're removed at the end.
  try {
    const add = page.getByRole('form', { name: 'Add an area' });
    await add.getByLabel('PIN codes starting').fill('560');
    await add.getByLabel(/Area name/).fill('Bengaluru');
    await add.getByLabel('Fastest, days').fill('1');
    await add.getByLabel('Slowest, days').fill('2');
    await add.getByRole('button', { name: 'Add area' }).click();
    await expect(page.getByRole('status')).toHaveText('Added 560');
    await add.getByLabel('PIN codes starting').fill('79');
    await add.getByLabel(/Delivered\?/).selectOption('No');
    await expect(add.getByLabel('Fastest, days')).toHaveCount(0);
    await add.getByRole('button', { name: 'Add area' }).click();
    await expect(page.getByRole('row', { name: /79/ })).toContainText('Not delivered');
    await expect(page.getByRole('row', { name: /560/ })).toContainText('1–2 days');

    // A shopper, logged out, in another browser.
    const shopper = await browser.newPage();
    await shopper.goto(BOOK);
    const check = shopper.getByRole('form', { name: 'Check delivery' });
    await check.getByLabel('Check delivery').fill('560001');
    await check.getByRole('button', { name: 'Check' }).click();
    await expect(check.locator('.delivery-result')).toHaveText(
      /^Delivered to 560001 \(Bengaluru\) by \w{3}, \d{1,2} \w{3} – /,
    );
    await check.getByLabel('Check delivery').fill('795001');
    await check.getByRole('button', { name: 'Check' }).click();
    await expect(check.locator('.delivery-result')).toHaveText("Sorry, we don't deliver to 795001 yet.");
    await check.getByLabel('Check delivery').fill('12');
    await check.getByRole('button', { name: 'Check' }).click();
    await expect(check.locator('.delivery-result')).toHaveText('Enter a 6-digit PIN code');
    // The last PIN checked is remembered on the next product page.
    await shopper.goto('/p/learning-to-code-with-javascript');
    await expect(shopper.getByRole('textbox', { name: 'Check delivery' })).toHaveValue('795001');
    await expect(shopper.getByRole('form', { name: 'Check delivery' }).locator('.delivery-result')).toHaveText(
      "Sorry, we don't deliver to 795001 yet.",
    );
    await shopper.close();
  } finally {
    const { zones } = await (await page.request.get('/api/admin/delivery')).json();
    for (const z of zones) await page.request.delete(`/api/admin/delivery/zones/${z.id}`);
  }
});
