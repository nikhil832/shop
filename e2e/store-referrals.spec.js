import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const ADDRESS = {
  'Mobile number': '9876543210',
  'Address (house, street, area)': '4 Lake View',
  City: 'Chennai',
  State: 'Tamil Nadu',
  'PIN code': '600001',
};

// Switched off again at the end: every spec shares this server.
test('a customer shares their link; a friend arriving through it gets the welcome on their first order', async ({
  page,
  browser,
}) => {
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await admin.goto('/admin/coupons');
  const form = admin.getByRole('form', { name: 'Refer a friend' });
  try {
    await form.getByRole('checkbox', { name: 'Offer referrals' }).check();
    await form.getByRole('button', { name: 'Save referrals' }).click();
    await expect(form.getByRole('status')).toHaveText('Saved.');

    // The customer's link, on their account page.
    await page.request.post('/api/auth/register', {
      data: { name: 'Asha Rao', email: `referrer-${Date.now()}@example.com`, password: 'password123' },
    });
    await page.goto('/account#referral');
    const section = page.getByRole('region', { name: 'Refer a friend' });
    await expect(section).toContainText('get ₹100 off their first order of ₹500 or more');
    const link = await section.getByRole('textbox', { name: 'Your link' }).inputValue();
    expect(link).toMatch(/\/\?ref=[A-Z2-9]{8}$/);
    expect(
      (await new AxeBuilder({ page }).include('#referral').withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    ).toEqual([]);

    // A friend opens it, then shops without an account.
    const friend = await (await browser.newContext()).newPage();
    await friend.goto(link.replace(/^https?:\/\/[^/]+/, ''));
    await friend.goto('/p/orbit-a14-4gb-ram-64gb');
    await friend.getByRole('button', { name: 'Add to cart' }).click();
    await friend.goto('/checkout');
    const summary = friend.getByRole('complementary', { name: 'Order summary' });
    await expect(summary).toContainText("Friend's welcome−₹100");
    await friend.getByLabel('Your name').fill('Neha Joshi');
    await friend.getByLabel('Email').fill(`friend-${Date.now()}@example.com`);
    await friend.getByLabel('Full name').fill('Neha Joshi');
    for (const [label, value] of Object.entries(ADDRESS)) await friend.getByLabel(label).fill(value);
    await friend.getByRole('radio', { name: /Cash on Delivery/ }).check();
    await friend.getByRole('button', { name: 'Place order · ₹8,899' }).click();
    await expect(friend).toHaveURL(/\/orders\/[0-9a-f]{24}$/);

    await page.reload();
    await expect(section).toContainText('1 friend has joined');
  } finally {
    await admin.request.put('/api/admin/referrals', {
      data: { enabled: false, friendDiscount: 10000, minOrder: 50000, reward: 10000, monthlyCap: 10 },
    });
  }
});
