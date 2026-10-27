import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const ADDRESS = {
  name: 'Meera Iyer',
  phone: '9123456780',
  line1: '12 Hill Road',
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411001',
};

test('guests write from "Contact us"; customers ask about an order, and see the reply', async ({ page, browser }) => {
  const stamp = Date.now().toString(36);

  // A guest, from the footer.
  const guest = await (await browser.newContext()).newPage();
  await guest.goto('/');
  await guest.getByRole('link', { name: 'Contact us' }).click();
  await expect(guest.getByRole('heading', { name: 'Contact us' })).toBeVisible();
  await guest.getByLabel('Your name').fill('Kiran S');
  await guest.getByLabel('Your email').fill(`kiran-${stamp}@example.com`);
  await guest.getByLabel('What is it about?').selectOption({ label: 'A product' });
  await guest.getByLabel('Your message').fill(`Do you deliver to Goa? (${stamp})`);
  await guest.getByRole('button', { name: 'Send' }).click();
  await expect(guest.getByRole('status')).toContainText(`will reply to kiran-${stamp}@example.com`);

  // A customer with an order (Cash on Delivery), from the order's page.
  const api = page.request;
  await api.post('/api/auth/register', {
    data: { name: 'Meera Iyer', email: `help-${stamp}@example.com`, password: 'password123' },
  });
  const { items } = await (await api.get('/api/products?q=quiet%20engineer')).json();
  const lines = [{ productId: items[0].id, qty: 1 }];
  const quote = await (await api.get(`/api/cart?items=${items[0].id}:1`)).json();
  const order = await (
    await api.post('/api/orders', { data: { items: lines, address: ADDRESS, expectedTotal: quote.total } })
  ).json();
  await page.goto(`/orders/${order.id}`);
  await page.getByRole('link', { name: 'Get help with this order' }).click();
  await expect(page.getByRole('heading', { name: `Help with order #${order.number}` })).toBeVisible();
  const question = `Can it come before Friday? (${stamp})`;
  await page.getByLabel('Your message').fill(question);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('heading', { name: /^Request #\d+: An order$/ })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Sent.');
  const requestUrl = page.url();

  // The admin answers from the inbox (the order is linked).
  const admin = await (await browser.newContext()).newPage();
  expect((await admin.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await admin.goto('/admin/help');
  // Request cards (each holds its own list of messages).
  const card = admin.locator('li.question-card').filter({ hasText: question });
  await expect(card.getByRole('link', { name: `Order #${order.number}` })).toBeVisible();
  await card.getByLabel('Reply to Meera Iyer').fill('Yes, it leaves today.');
  await card.getByRole('button', { name: 'Send reply' }).click();
  await expect(card).toHaveCount(0); // now under Answered
  await admin.getByRole('button', { name: /^Answered/ }).click();
  await expect(admin.locator('li.question-card').filter({ hasText: question })).toContainText('Yes, it leaves today.');

  // The customer sees the reply, and writes again.
  await page.goto(requestUrl);
  await expect(page.getByText('Answered')).toBeVisible();
  await expect(page.getByText('Yes, it leaves today.')).toBeVisible();
  await page.getByLabel('Write again').fill('Thank you very much.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Waiting for us')).toBeVisible();
  await page.goto('/help');
  await expect(page.getByRole('link', { name: /Request #\d+: An order/ })).toBeVisible();
});
