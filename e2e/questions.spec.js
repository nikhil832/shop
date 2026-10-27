import { test, expect } from '@playwright/test';

// The demo never sends email, so the API tests cover the email; this checks asking, answering and showing.
const PRODUCT = '/p/orbit-a14-4gb-ram-64gb';
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

test('a customer asks, an admin answers, and everyone sees the answer', async ({ page, browser }) => {
  const question = `Does it support dual SIM? (${Date.now()})`;
  await page.goto(PRODUCT);
  const qa = page.getByRole('region', { name: 'Questions & answers' });
  await expect(qa.getByRole('link', { name: 'Log in' })).toHaveAttribute(
    'href',
    `/login?next=${encodeURIComponent(`${PRODUCT}#questions`)}`,
  );

  const email = `ask-${Date.now()}@example.com`;
  await page.request.post('/api/auth/register', { data: { name: 'Meera Iyer', email, password: 'password123' } });
  await page.reload();
  await qa.getByLabel('Ask a question').fill(question);
  await qa.getByRole('button', { name: 'Ask' }).click();
  const waiting = qa.getByRole('heading', { name: 'Your question, waiting for an answer' });
  await expect(waiting).toBeVisible();
  await expect(qa.getByText(question)).toBeVisible();

  // An admin, in another browser, answers it from the Questions tab (oldest first, so find this one).
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await admin.goto('/login?next=%2Fadmin%2Fquestions');
  await admin.getByLabel('Email').fill(ADMIN.email);
  await admin.getByLabel('Password').fill(ADMIN.password);
  await admin.getByRole('button', { name: 'Log in' }).click();
  await expect(admin.getByRole('heading', { name: 'Questions' })).toBeVisible();
  const card = admin.getByRole('listitem').filter({ hasText: question });
  await expect(card).toContainText(`Meera Iyer (${email})`);
  await card.getByLabel('Your answer').fill('Yes: two nano SIMs and a memory card.');
  await card.getByRole('button', { name: 'Answer', exact: true }).click();
  await expect(card).toHaveCount(0); // moved to Answered
  await admin.getByRole('button', { name: /^Answered/ }).click();
  await expect(admin.getByRole('listitem').filter({ hasText: question }).getByLabel('Answer')).toHaveValue(
    'Yes: two nano SIMs and a memory card.',
  );
  await adminContext.close();

  // The customer, and a visitor, see it answered.
  await page.reload();
  await expect(waiting).toHaveCount(0);
  const answered = qa.getByRole('listitem').filter({ hasText: question });
  await expect(answered).toContainText('A: Yes: two nano SIMs and a memory card.');
  await expect(answered).toContainText('Asked by Meera I.');
  const visitor = await browser.newPage();
  await visitor.goto(`${PRODUCT}#questions`);
  await expect(visitor.getByText(question)).toBeVisible();
  await visitor.close();
});
