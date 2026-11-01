import { test, expect } from '@playwright/test';

// Birthday treat (stage 141). Switched off again at the end, as every spec shares one demo server; the demo sends no
// email, so the coupon itself is covered by the API tests.
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

test('a customer saves a birthday, and the account page names the treat once it is on', async ({ page, browser }) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await page.request.post('/api/auth/register', {
    data: { name: 'Tara Shah', email: `bday-${Date.now().toString(36)}@example.com`, password: 'password123' },
  });
  try {
    await admin.goto('/admin/coupons');
    const form = admin.getByRole('form', { name: 'Birthday treat' });
    await form.getByLabel('Give birthday treats').check();
    await form.getByLabel('Amount off (₹)').fill('150');
    await form.getByLabel('On orders from (₹)').fill('600');
    await form.getByRole('button', { name: 'Save birthday treat' }).click();
    await expect(form.getByRole('status')).toHaveText('Saved.');

    await page.goto('/account#birthday');
    const section = page.getByRole('form', { name: 'Your birthday' });
    await expect(section).toContainText("On your birthday we'll email you ₹150 off an order of ₹600 or more.");
    await section.getByLabel('Day').selectOption('14');
    await section.getByLabel('Month').selectOption('February');
    await section.getByRole('button', { name: 'Save birthday' }).click();
    await expect(section.getByRole('status')).toHaveText('Birthday saved.');
    await page.reload();
    await expect(section.getByLabel('Month')).toHaveValue('2');
    await section.getByRole('button', { name: 'Remove birthday' }).click();
    await expect(section.getByRole('status')).toHaveText('Birthday removed.');
    await expect(section.getByRole('button', { name: 'Remove birthday' })).toHaveCount(0);
  } finally {
    const current = await (await admin.request.get('/api/admin/birthday')).json();
    await admin.request.put('/api/admin/birthday', {
      data: { enabled: false, amount: current.amount, minOrder: current.minOrder, validDays: current.validDays },
    });
  }
});
