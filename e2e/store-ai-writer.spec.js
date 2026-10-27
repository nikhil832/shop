import { test, expect } from '@playwright/test';

// The demo server's writing assistant talks to a stand-in Claude API (server/test/fake-anthropic.js, started by
// playwright.config.js), so this never calls the real one. Nothing is saved.
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js

test('"Write for me" fills in the highlights and description for the admin to check', async ({ page }) => {
  await page.goto('/login?next=%2Fadmin%2Fproducts%2Fnew');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Add product' })).toBeVisible();

  // Without a title yet, the server says what's missing.
  await page.getByRole('button', { name: 'Write for me' }).click();
  await expect(page.getByRole('alert')).toContainText('Enter a title first');

  await page.getByLabel('Title').fill('Griha Ceramic Vase');
  await page.getByLabel('Brand').fill('Griha');
  await page.getByLabel('Category').selectOption({ label: 'Home & Kitchen' });
  await page.getByLabel(/^Highlights/).fill('Hand-glazed');
  await page.getByRole('button', { name: 'Write for me' }).click();
  await expect(page.getByLabel(/^Highlights/)).toHaveValue('Easy to use\nBuilt to last\nGreat value');
  await expect(page.getByLabel('Description')).toHaveValue(/^Griha Ceramic Vase is a dependable pick/);
  await expect(page.getByText('Draft written. Check every detail before saving')).toBeVisible();

  // With a description there, it asks before replacing it; saying no keeps the admin's edit.
  await page.getByLabel('Description').fill('My own words.');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Write for me' }).click();
  await expect(page.getByLabel('Description')).toHaveValue('My own words.');
});

test('"Draft an answer" fills in a reply to a question for the admin to check and send', async ({ page, browser }) => {
  // A customer asks two questions: one the details answer, one they don't (the stand-in says so for warranties).
  const customer = (await (await browser.newContext()).newPage()).request;
  const stamp = Date.now();
  await customer.post('/api/auth/register', {
    data: { name: 'Meera Iyer', email: `draft-${stamp}@example.com`, password: 'password123' },
  });
  const ask = (text) => customer.post('/api/products/aura-electric-kettle-1-5l/questions', { data: { text } });
  const known = `Is the body steel? (${stamp})`;
  const unsure = `What is the warranty? (${stamp})`;
  expect((await ask(known)).ok()).toBe(true);
  expect((await ask(unsure)).ok()).toBe(true);

  await page.goto('/login?next=%2Fadmin%2Fquestions');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible();

  const card = page.getByRole('listitem').filter({ hasText: known });
  await card.getByRole('button', { name: 'Draft an answer' }).click();
  await expect(card.getByLabel('Your answer')).toHaveValue(
    'Yes: Aura Electric Kettle 1.5L comes with what the description lists.',
  );
  await expect(card.getByText('Draft written from the product’s details')).toBeVisible();
  await card.getByLabel('Your answer').fill('Yes: stainless steel inside and out.');
  await card.getByRole('button', { name: 'Answer', exact: true }).click();
  await expect(card).toHaveCount(0); // answered: moved to Answered

  const other = page.getByRole('listitem').filter({ hasText: unsure });
  await other.getByRole('button', { name: 'Draft an answer' }).click();
  await expect(other.getByText('The product’s details don’t settle this')).toBeVisible();
});

test('the weekly note: switched off and on from the dashboard, and sent to the admin on request', async ({ page }) => {
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await page.goto('/admin');
  const panel = page.getByRole('region', { name: 'Weekly note' });
  const box = panel.getByLabel('Each Monday, email admins a note about last week');
  await expect(box).toBeChecked();
  await box.uncheck();
  await page.reload();
  await expect(box).not.toBeChecked();
  await box.check();
  await page.reload();
  await expect(box).toBeChecked();

  await panel.getByRole('button', { name: 'Send me one now' }).click();
  await expect(panel.getByText('Sent to your email: last week’s note.')).toBeVisible();
});

test('photo descriptions: Claude suggests one, the admin saves it, and the product page reads it out', async ({
  page,
}) => {
  const api = page.request;
  expect((await api.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const { url } = await (
    await api.post('/api/admin/images', { headers: { 'Content-Type': 'image/png' }, data: png })
  ).json();
  const [category] = await (await api.get('/api/categories')).json();
  const product = await (
    await api.post('/api/admin/products', {
      data: {
        title: `Griha Glass Vase ${Date.now()}`,
        brand: 'Griha',
        categoryId: category.id,
        price: 49900,
        mrp: 59900,
        stock: 5,
        images: [url],
      },
    })
  ).json();

  await page.goto(`/admin/products/${product.id}`);
  const description = page.getByLabel('Description of image 1');
  await expect(description).toHaveValue('');
  await page.getByRole('button', { name: 'Suggest a description of image 1' }).click();
  await expect(description).toHaveValue('a blue vase, seen from the side');
  await description.fill('Clear glass vase with a blue rim, from the side');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL('/admin/products');

  await page.goto(`/p/${product.slug}`);
  await expect(page.getByRole('img', { name: 'Clear glass vase with a blue rim, from the side' })).toBeVisible();
});

test('"What customers say": admins switch it for the store; the product page shows it, labelled as AI', async ({
  page,
}) => {
  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await page.goto('/admin/reviews');
  const box = page.getByLabel('Show “What customers say” on product pages');
  await expect(box).toBeChecked();
  await box.uncheck();
  await page.reload();
  await expect(box).not.toBeChecked();
  await box.check();
  await page.reload();
  await expect(box).toBeChecked();

  // Summaries are written minutes after reviews settle (API tests cover that); here the page is given one.
  await page.route('**/api/products/aura-electric-kettle-1-5l/reviews?*', async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.summary = {
      text: 'Most reviewers like how fast it boils; a few find the lid stiff.',
      count: 4,
      at: '2026-10-27',
    };
    await route.fulfill({ response: res, json });
  });
  await page.goto('/p/aura-electric-kettle-1-5l');
  const reviews = page.getByRole('region', { name: 'Ratings & reviews' });
  await expect(reviews.getByRole('heading', { name: 'What customers say' })).toBeVisible();
  await expect(reviews.getByText('Most reviewers like how fast it boils')).toBeVisible();
  await expect(reviews.getByText('Summarised by AI from 4 written reviews.')).toBeVisible();
});

test('screening: a flagged question shows why under Flagged, and "Looks fine" clears it', async ({ page, browser }) => {
  const customer = (await (await browser.newContext()).newPage()).request;
  const stamp = Date.now();
  await customer.post('/api/auth/register', {
    data: { name: 'Kiran S', email: `flag-${stamp}@example.com`, password: 'password123' },
  });
  // No long numbers (the stamp is written in letters too): the demo server's own screening, which flags 10-digit
  // numbers, also runs every minute and must not flag this question for real.
  const text = `Is the handle heat-proof? (${stamp.toString(36)})`;
  const asked = await (
    await customer.post('/api/products/aura-electric-kettle-1-5l/questions', { data: { text } })
  ).json();

  // Screening runs from the minute sweep (API tests cover it); here the Flagged list is given the question, with the
  // flag screening would add, until the admin clears it.
  let flagged = true;
  await page.route('**/api/admin/questions?*', async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    if (flagged) {
      const screening = {
        flagged: true,
        reasons: ['personal_details'],
        note: 'It has a phone number.',
        cleared: false,
      };
      json.items = [{ ...asked, hidden: false, product: null, customer: null, screening }, ...json.items];
    }
    await route.fulfill({ response: res, json });
  });
  page.on('request', (r) => {
    if (r.url().includes(`/api/admin/screening/question/${asked.id}/clear`)) flagged = false;
  });

  expect((await page.request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  await page.goto('/admin/questions?status=flagged');
  const card = page.getByRole('listitem').filter({ hasText: text });
  await expect(card.getByText('Flagged: Personal details')).toBeVisible();
  await expect(card.getByText('It has a phone number.')).toBeVisible();
  await card.getByRole('button', { name: 'Looks fine (clear the flag)' }).click();
  await expect(card).toHaveCount(0); // gone from the Flagged list
});

test('plain-words search: a search that finds nothing offers filters Claude read from it', async ({ page }) => {
  await page.goto('/search?q=running%20shoes%20under%203000');
  await expect(page.getByRole('heading', { name: 'No products found' })).toBeVisible();
  const offer = page.getByRole('link', { name: 'running shoes, in Fashion, up to ₹3,000' });
  await expect(offer).toBeVisible();
  await expect(page.getByText('(1 product)')).toBeVisible();
  await offer.click();
  await expect(page).toHaveURL(/q=running(\+|%20)shoes/);
  await expect(page).toHaveURL(/category=fashion/);
  await expect(page).toHaveURL(/maxPrice=3000/);
  await expect(page.getByRole('link', { name: /Stride Running Shoes/ }).first()).toBeVisible();

  // Under ₹2,000 there are none, so nothing is offered.
  await page.goto('/search?q=running%20shoes%20under%202000');
  await expect(page.getByRole('heading', { name: 'No products found' })).toBeVisible();
  await expect(page.getByText('Try a different search')).toBeVisible();
  await expect(page.getByText('Looking for')).toHaveCount(0);
});
