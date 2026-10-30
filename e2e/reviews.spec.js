import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Named to run after catalog.spec.js (files run alphabetically on one shared demo server): reviews change ratings.
const ADMIN = { email: 'admin@bazaar.demo', password: 'demo-admin-123' }; // created by server/src/demo.js
const SLUG = 'learning-to-code-with-javascript'; // ₹599, used by no other spec
const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Registers a customer in the page's browser and has an order of the book delivered, so they may review it.
// The admin steps use the separate `request` context, so the page stays logged in as the customer.
async function customerWhoReceivedIt(page, request) {
  const email = `reviewer-${unique()}@example.com`;
  await page.goto('/');
  const api = page.request;
  expect(
    (await api.post('/api/auth/register', { data: { name: 'Kavya Menon', email, password: 'password123' } })).ok(),
  ).toBe(true);
  const product = await (await api.get(`/api/products/${SLUG}`)).json();
  const quote = await (await api.get(`/api/cart?items=${product.id}:1`)).json();
  const order = await api.post('/api/orders', {
    data: {
      items: [{ productId: product.id, qty: 1 }],
      address: {
        name: 'Kavya Menon',
        phone: '9123456780',
        line1: '7 Marine Drive',
        city: 'Kochi',
        state: 'Kerala',
        pincode: '682031',
      },
      expectedTotal: quote.total,
    },
  });
  expect(order.status()).toBe(201);
  const { id } = await order.json();

  expect((await request.post('/api/auth/login', { data: ADMIN })).ok()).toBe(true);
  for (const status of ['shipped', 'delivered']) {
    expect((await request.post(`/api/admin/orders/${id}/status`, { data: { status } })).ok()).toBe(true);
  }
  return product;
}

// Clicks the star itself (its label); the radio inside is visually hidden.
const pickStars = (page, name) => page.getByRole('radio', { name, exact: true }).locator('..').click();
const reviews = (page) => page.getByRole('region', { name: 'Ratings & reviews' });

test('only a customer who received the product is offered the review form', async ({ page }) => {
  await page.goto(`/p/${SLUG}`);
  await expect(reviews(page)).toContainText('Bought this? Log in to write a review.');

  await page.request.post('/api/auth/register', {
    data: { name: 'Window Shopper', email: `browser-${unique()}@example.com`, password: 'password123' },
  });
  await page.reload();
  await expect(reviews(page)).toContainText(
    'You can review this product once an order with it has been delivered to you.',
  );
  await expect(page.getByRole('button', { name: 'Post review' })).toHaveCount(0);
});

test('a buyer writes, edits and deletes a review, and the rating follows', async ({ page, request }) => {
  page.on('dialog', (dialog) => dialog.accept());
  const product = await customerWhoReceivedIt(page, request);
  const count = product.rating.count;
  await page.goto(`/p/${SLUG}`);

  // Stars are required.
  await page.getByRole('button', { name: 'Post review' }).click();
  await expect(page.getByRole('alert')).toHaveText('Choose 1 to 5 stars');

  await pickStars(page, '4 stars');
  await page.getByLabel('Title (optional)').fill('Clear and practical');
  await page.getByLabel('Review (optional)').fill('Good first book.\nThe exercises help.');
  await page.getByRole('button', { name: 'Post review' }).click();

  const mine = page.locator('.my-review');
  await expect(mine).toContainText('Your review');
  await expect(mine.getByRole('img', { name: '4 out of 5 stars' })).toBeVisible();
  const list = reviews(page).getByRole('listitem');
  await expect(list.first()).toContainText('Clear and practical');
  await expect(list.first()).toContainText('Kavya M. · Verified buyer');
  // The product's rating count went up by one (sample ratings are kept).
  await expect(reviews(page)).toContainText(`${(count + 1).toLocaleString('en-IN')} ratings`);

  await mine.getByRole('button', { name: 'Edit' }).click();
  await pickStars(page, '2 stars');
  await page.getByLabel('Title (optional)').fill('Too basic for me');
  await page.getByRole('button', { name: 'Save review' }).click();
  await expect(mine).toContainText('Too basic for me');
  await expect(mine.getByRole('img', { name: '2 out of 5 stars' })).toBeVisible();
  await expect(reviews(page)).toContainText(`${(count + 1).toLocaleString('en-IN')} ratings`);

  await mine.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('button', { name: 'Post review' })).toBeVisible();
  await expect(reviews(page)).toContainText(`${count.toLocaleString('en-IN')} ratings`);
});

test('an admin hides a review and it leaves the product page', async ({ page, request }) => {
  await customerWhoReceivedIt(page, request);
  const title = `Hide me ${unique()}`;
  await page.goto(`/p/${SLUG}`);
  await pickStars(page, '1 star');
  await page.getByLabel('Title (optional)').fill(title);
  await page.getByRole('button', { name: 'Post review' }).click();
  await expect(reviews(page).getByRole('listitem').filter({ hasText: title })).toBeVisible();

  // Log the page in as the admin (replacing the customer's session) and hide it from the Reviews tab.
  await page.request.post('/api/auth/login', { data: ADMIN });
  await page.goto('/admin/reviews?status=visible');
  const row = page.getByRole('row').filter({ hasText: title });
  await expect(row).toContainText('Kavya Menon');
  await row.getByRole('button', { name: /^Hide/ }).click();
  await page.getByRole('button', { name: /^Hidden/ }).click();
  await expect(page.getByRole('row').filter({ hasText: title })).toContainText('Hidden');

  await page.goto(`/p/${SLUG}`);
  await expect(reviews(page)).not.toContainText(title);
});

test('saving products to the wishlist', async ({ page }) => {
  await page.goto(`/p/${SLUG}`);
  // Logged out, the button leads to the login page.
  await page.getByRole('link', { name: '♡ Save to wishlist' }).click();
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(`/p/${SLUG}`)}`);

  await page.request.post('/api/auth/register', {
    data: { name: 'Wish Ful', email: `wisher-${unique()}@example.com`, password: 'password123' },
  });
  await page.goto(`/p/${SLUG}`);
  const button = page.getByRole('button', { name: /Save.* to wishlist/ });
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await button.click();
  await expect(button).toHaveText('♥ Saved to wishlist');
  await expect(button).toHaveAttribute('aria-pressed', 'true');

  // Still saved after a reload: it's kept in the account.
  await page.reload();
  await expect(page.getByRole('button', { name: '♥ Saved to wishlist' })).toBeVisible();

  await page.getByRole('link', { name: 'View wishlist' }).click();
  await expect(page).toHaveURL('/wishlist');
  await expect(page.getByRole('heading', { name: /Wishlist/ })).toContainText('(1 item)');
  await page.getByRole('button', { name: 'Add to cart Learning to Code with JavaScript' }).click();
  await expect(page.getByRole('link', { name: 'In cart (1)' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Cart, 1 item/ })).toBeVisible();

  await page.getByRole('button', { name: 'Remove Learning to Code with JavaScript' }).click();
  await expect(page.getByText('Your wishlist is empty.')).toBeVisible();
  await page.getByRole('link', { name: 'My orders' }).click();
  await expect(page).toHaveURL('/orders');
});

test('a buyer adds photos to a review: shrunk, shown as thumbnails, removable', async ({ page, request }) => {
  page.on('dialog', (dialog) => dialog.accept());
  await customerWhoReceivedIt(page, request);
  await page.goto(`/p/${SLUG}`);
  await pickStars(page, '5 stars');
  await page.getByLabel('Title (optional)').fill('With pictures');

  // A real 1200×630 PNG: shrunk and uploaded as a JPEG.
  const uploads = [];
  page.on('response', (r) => r.url().endsWith('/api/reviews/photos') && uploads.push(r));
  const picture = 'client/public/og-image.png';
  await page.locator('.photo-add input[type=file]').setInputFiles([picture, picture]);
  const form = page.locator('.review-form').filter({ hasText: 'Your rating' });
  await expect(form.getByRole('img', { name: 'Photo 2' })).toBeVisible();
  expect(uploads.map((r) => r.status())).toEqual([201, 201]);
  expect(uploads[0].request().headers()['content-type']).toBe('image/jpeg');
  await form.getByRole('button', { name: 'Remove photo 2' }).click();
  await expect(form.getByRole('img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Post review' }).click();

  const shown = reviews(page).getByRole('listitem').filter({ hasText: 'With pictures' });
  const thumb = shown.getByRole('img', { name: "Photo 1 from Kavya M.'s review" });
  await expect(thumb).toBeVisible();
  const src = await thumb.getAttribute('src');
  const served = await page.request.get(src);
  expect(served.headers()['content-type']).toBe('image/jpeg');

  // Delete it again, so the book's rating is as other tests expect.
  await page.locator('.my-review').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('button', { name: 'Post review' })).toBeVisible();
});

test('reviews filter by stars, and other customers mark them helpful', async ({ page, browser, request }) => {
  // Two buyers review the book (4 and 5 stars), each in their own browser; the page is a third customer.
  const tag = unique();
  const authors = [];
  for (const rating of [4, 5]) {
    const context = await browser.newContext();
    const author = await context.newPage();
    await customerWhoReceivedIt(author, request);
    const res = await author.request.put(`/api/products/${SLUG}/review`, {
      data: { rating, title: `${rating} stars ${tag}` },
    });
    expect(res.ok()).toBe(true);
    authors.push(context);
  }
  try {
    const email = `reader-${unique()}@example.com`;
    await page.request.post('/api/auth/register', { data: { name: 'Ravi Kumar', email, password: 'password123' } });
    await page.goto(`/p/${SLUG}`);
    const section = reviews(page);
    const four = section.getByRole('listitem').filter({ hasText: `4 stars ${tag}` });
    const five = section.getByRole('listitem').filter({ hasText: `5 stars ${tag}` });
    await expect(five).toBeVisible();

    // Only four-star reviews, then all again.
    const fourStars = section.getByRole('button', { name: /^4 stars:/ });
    await fourStars.click();
    await expect(fourStars).toHaveAttribute('aria-pressed', 'true');
    await expect(four).toBeVisible();
    await expect(five).toHaveCount(0);
    await fourStars.click();
    await expect(five).toBeVisible();

    // A helpful vote, kept after a reload, and the most helpful first.
    const helpful = four.getByRole('button', { name: /^Helpful/ });
    await helpful.click();
    await expect(helpful).toHaveAttribute('aria-pressed', 'true');
    await expect(four).toContainText('1 person found this helpful');
    // The breakdown, filters and votes pass the accessibility check (WCAG 2.1 AA), as the page-wide run has no reviews.
    const { violations } = await new AxeBuilder({ page })
      .include('#reviews')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`)).toEqual([]);
    await page.reload();
    await expect(helpful).toHaveAttribute('aria-pressed', 'true');
    await section.getByLabel('Sort reviews').selectOption('helpful');
    await expect(section.locator('.review-list > li').first()).toContainText(`4 stars ${tag}`);
    await helpful.click();
    await expect(helpful).toHaveAttribute('aria-pressed', 'false');
    await expect(four).not.toContainText('found this helpful');
  } finally {
    // Deleted again, so the book's rating is as other tests expect.
    for (const context of authors) {
      await context.request.delete(`/api/products/${SLUG}/review`);
      await context.close();
    }
  }
});
