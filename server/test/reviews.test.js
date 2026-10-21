import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { shortName } from '../src/routes/reviews.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'Store Admin');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
});
after(() => t.stop());

let n = 0;
async function register(email = `buyer${++n}@example.com`, name = 'Asha Rao') {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name, email, password: 'password123' });
  assert.equal(res.status, 201);
  return call;
}

const BOOK = 'the-quiet-engineer-paperback';
const product = (slug) => t.db.collection('products').findOne({ slug });
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};

// Places a COD order for one of `slug` and has the admin ship it, and deliver it unless `deliver` is false.
async function buy(call, slug, { deliver = true } = {}) {
  const p = await product(slug);
  const quote = await call('GET', `/cart?items=${p._id}:1`);
  const order = await call('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty: 1 }],
    address,
    expectedTotal: quote.body.total,
  });
  assert.equal(order.status, 201);
  assert.equal((await admin('POST', `/admin/orders/${order.body.id}/status`, { status: 'shipped' })).status, 200);
  if (deliver) {
    assert.equal((await admin('POST', `/admin/orders/${order.body.id}/status`, { status: 'delivered' })).status, 200);
  }
  return order.body;
}

// A customer who has received `slug` and may review it.
async function buyer(slug = BOOK, name) {
  const call = await register(undefined, name);
  await buy(call, slug);
  return call;
}

test('only customers who received the product can review it', async () => {
  const review = { rating: 5, title: 'Great', body: 'Loved it' };
  assert.equal((await t.call('PUT', `/products/${BOOK}/review`, review)).status, 401);

  const call = await register();
  let res = await call('PUT', `/products/${BOOK}/review`, review);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'You can review this once an order with it has been delivered to you');

  // Shipped is not enough.
  await buy(call, BOOK, { deliver: false });
  assert.equal((await call('PUT', `/products/${BOOK}/review`, review)).status, 403);
  res = await call('GET', `/products/${BOOK}/reviews`);
  assert.deepEqual(res.body.viewer, { review: null, canReview: false });

  // A logged-out visitor gets no viewer section.
  assert.equal((await t.call('GET', `/products/${BOOK}/reviews`)).body.viewer, null);
});

test('a review is added to the existing rating, and edits and deletes keep it right', async () => {
  const before = await product(BOOK);
  const call = await buyer(BOOK, 'Asha Rao');

  let res = await call('PUT', `/products/${BOOK}/review`, {
    rating: 5,
    title: ' Great read ',
    body: 'Short and useful.',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'Great read');
  assert.equal(res.body.author, 'Asha R.');
  assert.equal(res.body.hidden, false);

  // Sample ratings are kept as the base, and the new review is added to them.
  const base = before.rating;
  let p = await product(BOOK);
  assert.deepEqual(p.ratingBase, base);
  assert.equal(p.rating.count, base.count + 1);
  const expected = (stars, count) => Math.round(((base.avg * base.count + stars) / (base.count + count)) * 10) / 10;
  assert.equal(p.rating.avg, expected(5, 1));

  res = await t.call('GET', `/products/${BOOK}/reviews`);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.items[0].body, 'Short and useful.');
  assert.equal(res.body.items[0].author, 'Asha R.');
  res = await call('GET', `/products/${BOOK}/reviews`);
  assert.equal(res.body.viewer.canReview, true);
  assert.equal(res.body.viewer.review.rating, 5);

  // Editing replaces the review (still one) and moves the rating by the difference.
  res = await call('PUT', `/products/${BOOK}/review`, { rating: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.title, '');
  p = await product(BOOK);
  assert.equal(p.rating.count, base.count + 1);
  assert.equal(p.reviewStats.sum, 1);
  assert.equal((await t.call('GET', `/products/${BOOK}/reviews`)).body.total, 1);

  // Deleting returns the product to its sample rating.
  assert.equal((await call('DELETE', `/products/${BOOK}/review`)).status, 204);
  p = await product(BOOK);
  assert.deepEqual(p.rating, base);
  assert.equal((await call('DELETE', `/products/${BOOK}/review`)).status, 404);
});

test('a product without sample ratings is rated by its reviews alone', async () => {
  const res = await admin('POST', '/admin/products', {
    title: 'Review Test Lamp',
    brand: 'Lumo',
    categoryId: (await product(BOOK)).categoryId.toString(),
    price: 49900,
    mrp: 49900,
    stock: 50,
  });
  assert.equal(res.status, 201);
  const slug = res.body.slug;
  const one = await buyer(slug);
  const two = await buyer(slug);
  await one('PUT', `/products/${slug}/review`, { rating: 4 });
  await two('PUT', `/products/${slug}/review`, { rating: 5 });
  assert.deepEqual((await t.call('GET', `/products/${slug}`)).body.rating, { avg: 4.5, count: 2 });
});

test('review input is validated', async () => {
  const call = await buyer();
  const cases = [
    [{}, 'rating: Invalid input: expected number, received undefined'],
    [{ rating: 0 }, 'rating: Choose 1 to 5 stars'],
    [{ rating: 6 }, 'rating: Choose 1 to 5 stars'],
    [{ rating: 4.5 }, 'rating: Invalid input: expected int, received number'],
    [{ rating: 4, title: 'x'.repeat(101) }, 'title: Too big: expected string to have <=100 characters'],
    [{ rating: 4, body: 'x'.repeat(2001) }, 'body: Too big: expected string to have <=2000 characters'],
  ];
  for (const [body, error] of cases) {
    const res = await call('PUT', `/products/${BOOK}/review`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error, error);
  }
  assert.equal((await call('PUT', '/products/no-such-product/review', { rating: 4 })).status, 404);
  assert.equal((await t.call('GET', '/products/no-such-product/reviews')).status, 404);
});

test('reviews are listed newest first, ten per page', async () => {
  const slug = 'monsoon-stories-hardcover';
  for (let i = 1; i <= 11; i++) {
    const call = await buyer(slug, `Reader ${i}`);
    await call('PUT', `/products/${slug}/review`, { rating: 4, title: `Review ${i}` });
  }
  let res = await t.call('GET', `/products/${slug}/reviews`);
  assert.equal(res.body.total, 11);
  assert.equal(res.body.items.length, 10);
  assert.equal(res.body.items[0].title, 'Review 11');
  res = await t.call('GET', `/products/${slug}/reviews?page=2`);
  assert.deepEqual(
    res.body.items.map((r) => r.title),
    ['Review 1'],
  );
});

test('admins can hide and show reviews; hidden ones leave the page and the rating', async () => {
  const slug = 'urbane-men-cotton-polo-t-shirt';
  const base = (await product(slug)).rating;
  const call = await buyer(slug, 'Ravi Kumar');
  const { body: review } = await call('PUT', `/products/${slug}/review`, { rating: 1, body: 'Rude words' });

  // Customers can't moderate.
  assert.equal((await call('GET', '/admin/reviews')).status, 403);
  assert.equal((await call('POST', `/admin/reviews/${review.id}/visibility`, { hidden: true })).status, 403);
  assert.equal((await t.call('GET', '/admin/reviews')).status, 401);

  let res = await admin('GET', '/admin/reviews?status=visible');
  const listed = res.body.items.find((r) => r.id === review.id);
  assert.deepEqual(listed.product, { title: 'Urbane Men Cotton Polo T-Shirt', slug, active: true });
  assert.deepEqual(listed.customer.name, 'Ravi Kumar');

  // Hiding twice counts once.
  for (let i = 0; i < 2; i++) {
    res = await admin('POST', `/admin/reviews/${review.id}/visibility`, { hidden: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.hidden, true);
  }
  assert.deepEqual((await product(slug)).rating, base);
  assert.equal((await t.call('GET', `/products/${slug}/reviews`)).body.total, 0);
  // The author still sees it (marked hidden) and can't post a second one.
  res = await call('GET', `/products/${slug}/reviews`);
  assert.equal(res.body.viewer.review.hidden, true);

  // Editing a hidden review keeps it hidden and out of the rating.
  await call('PUT', `/products/${slug}/review`, { rating: 2, body: 'Edited' });
  assert.deepEqual((await product(slug)).rating, base);
  res = await admin('GET', '/admin/reviews?status=hidden');
  assert.ok(res.body.items.some((r) => r.id === review.id && r.body === 'Edited'));
  assert.ok(res.body.counts.hidden >= 1);

  res = await admin('POST', `/admin/reviews/${review.id}/visibility`, { hidden: false });
  assert.equal(res.body.hidden, false);
  assert.equal((await product(slug)).rating.count, base.count + 1);
  assert.equal((await t.call('GET', `/products/${slug}/reviews`)).body.total, 1);

  assert.equal((await admin('POST', `/admin/reviews/${'0'.repeat(24)}/visibility`, { hidden: true })).status, 404);
  assert.equal((await admin('POST', `/admin/reviews/${review.id}/visibility`, {})).status, 400);
});

test('reviewer names are shortened to first name and initial', () => {
  assert.equal(shortName('Asha Rao'), 'Asha R.');
  assert.equal(shortName('  Ravi  kumar singh '), 'Ravi S.');
  assert.equal(shortName('Madonna'), 'Madonna');
});
