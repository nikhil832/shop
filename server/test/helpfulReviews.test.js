import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { startTestServer } from './helpers.js';

let t;
let admin;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'Store Admin');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
});
after(() => t.stop());
beforeEach(() => t.db.collection('rateLimits').deleteMany({}));

let n = 0;
async function register(email = `buyer${++n}@example.com`, name = 'Asha Rao') {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name, email, password: 'password123' });
  assert.equal(res.status, 201);
  return call;
}

const BOOK = 'the-quiet-engineer-paperback';
const PHONE = 'orbit-a14-4gb-ram-64gb';
const product = (slug) => t.db.collection('products').findOne({ slug });
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};

// A customer who received `slug` and reviewed it with `rating` stars.
async function reviewer(slug, rating, extra = {}) {
  const call = await register();
  const p = await product(slug);
  const quote = await call('GET', `/cart?items=${p._id}:1`);
  const order = await call('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty: 1 }],
    address,
    expectedTotal: quote.body.total,
  });
  for (const status of ['shipped', 'delivered']) {
    assert.equal((await admin('POST', `/admin/orders/${order.body.id}/status`, { status })).status, 200);
  }
  const res = await call('PUT', `/products/${slug}/review`, { rating, title: `${rating} stars`, ...extra });
  assert.equal(res.status, 200);
  return { call, review: res.body };
}

test('customers mark others’ reviews helpful once, and can take it back', async () => {
  const { call: author, review } = await reviewer(BOOK, 4);
  const reader = await register();
  const helpful = `/reviews/${review.id}/helpful`;

  assert.equal((await t.call('POST', helpful)).status, 401);
  assert.equal((await author('POST', helpful)).status, 400); // their own
  assert.equal((await reader('POST', '/reviews/nope/helpful')).status, 400);
  assert.equal((await reader('POST', `/reviews/${new ObjectId()}/helpful`)).status, 404);

  assert.deepEqual((await reader('POST', helpful)).body, { helpful: 1, votedHelpful: true });
  assert.deepEqual((await reader('POST', helpful)).body, { helpful: 1, votedHelpful: true }); // twice counts once
  const second = await register();
  assert.deepEqual((await second('POST', helpful)).body, { helpful: 2, votedHelpful: true });

  let list = await reader('GET', `/products/${BOOK}/reviews`);
  const item = list.body.items.find((r) => r.id === review.id);
  assert.equal(item.helpful, 2);
  assert.equal(item.votedHelpful, true);
  list = await t.call('GET', `/products/${BOOK}/reviews`);
  assert.equal(list.body.items.find((r) => r.id === review.id).votedHelpful, undefined); // logged out

  assert.deepEqual((await reader('DELETE', helpful)).body, { helpful: 1, votedHelpful: false });
  assert.deepEqual((await reader('DELETE', helpful)).body, { helpful: 1, votedHelpful: false }); // nothing to take back

  // A hidden review takes no votes; deleting a review deletes its votes.
  await t.db.collection('reviews').updateOne({ _id: new ObjectId(review.id) }, { $set: { hidden: true } });
  assert.equal((await reader('POST', helpful)).status, 404);
  await t.db.collection('reviews').updateOne({ _id: new ObjectId(review.id) }, { $set: { hidden: false } });
  assert.equal((await author('DELETE', `/products/${BOOK}/review`)).status, 204);
  assert.equal(await t.db.collection('reviewVotes').countDocuments({ reviewId: new ObjectId(review.id) }), 0);
});

test('votes are limited per hour', async () => {
  const { review } = await reviewer(BOOK, 5);
  const reader = await register();
  const user = await t.db.collection('users').findOne({ email: `buyer${n}@example.com` });
  // The hour's 100 votes already used.
  const uses = Array.from({ length: 100 }, (_, i) => ({ at: new Date(), id: String(i) }));
  await t.db
    .collection('rateLimits')
    .insertOne({ _id: `helpful:${user._id}`, uses, expiresAt: new Date(Date.now() + 3_600_000) });
  assert.equal((await reader('POST', `/reviews/${review.id}/helpful`)).status, 429);
  assert.equal(
    (await reader('GET', `/products/${BOOK}/reviews`)).body.items.find((r) => r.id === review.id).helpful,
    0,
  );
});

test('reviews filter by stars and photos, sort by most helpful, with a breakdown', async () => {
  const slug = PHONE;
  const { review: five } = await reviewer(slug, 5);
  const { review: four } = await reviewer(slug, 4);
  const { review: fourToo } = await reviewer(slug, 4);
  const photo = { id: new ObjectId() };
  await t.db
    .collection('reviews')
    .updateOne({ _id: new ObjectId(four.id) }, { $set: { photos: [`/api/images/${photo.id}`] } });
  // The older four-star review is the most helpful.
  for (let i = 0; i < 2; i++) await (await register())('POST', `/reviews/${fourToo.id}/helpful`);
  await (
    await register()
  )('POST', `/reviews/${four.id}/helpful`);

  const get = async (query = '') => (await t.call('GET', `/products/${slug}/reviews${query}`)).body;
  const all = await get();
  assert.deepEqual(all.breakdown, { 1: 0, 2: 0, 3: 0, 4: 2, 5: 1 });
  assert.equal(all.withPhotos, 1);
  assert.deepEqual(
    all.items.map((r) => r.id),
    [fourToo.id, four.id, five.id],
  ); // newest first

  const helpful = await get('?sort=helpful');
  assert.deepEqual(
    helpful.items.map((r) => [r.id, r.helpful]),
    [
      [fourToo.id, 2],
      [four.id, 1],
      [five.id, 0],
    ],
  );

  const fours = await get('?stars=4');
  assert.equal(fours.total, 2);
  assert.ok(fours.items.every((r) => r.rating === 4));
  assert.deepEqual(fours.breakdown, all.breakdown); // the breakdown ignores the filter

  const photos = await get('?photos=1');
  assert.deepEqual(
    photos.items.map((r) => r.id),
    [four.id],
  );
  assert.equal((await get('?stars=1')).total, 0);

  for (const bad of ['?stars=6', '?stars=x', '?sort=oldest', '?photos=yes']) {
    assert.equal((await t.call('GET', `/products/${slug}/reviews${bad}`)).status, 400, bad);
  }
});

test('closing an account takes its votes off reviews and deletes votes on its reviews', async () => {
  const { review } = await reviewer(BOOK, 3);
  const { call: leaving, review: theirs } = await reviewer(BOOK, 2);
  await leaving('POST', `/reviews/${review.id}/helpful`);
  await (
    await register()
  )('POST', `/reviews/${theirs.id}/helpful`);
  const before = await t.db.collection('reviews').findOne({ _id: new ObjectId(review.id) });
  assert.equal(before.helpful, 1);

  const data = await leaving('GET', '/account/data');
  assert.equal(data.body.helpfulVotes, 1);

  assert.equal((await leaving('POST', '/account/close', { password: 'password123', confirm: true })).status, 204);
  assert.equal((await t.db.collection('reviews').findOne({ _id: new ObjectId(review.id) })).helpful, 0);
  assert.equal(await t.db.collection('reviewVotes').countDocuments({ reviewId: new ObjectId(theirs.id) }), 0);
});
