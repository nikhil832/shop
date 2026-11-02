import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let support;
let packer;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'Store Admin');
  support = await register('support@example.com', 'Sunil Support');
  packer = await register('packer@example.com', 'Pooja Packer');
  const users = t.db.collection('users');
  await users.updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  await users.updateOne({ email: 'support@example.com' }, { $set: { role: 'support' } });
  await users.updateOne({ email: 'packer@example.com' }, { $set: { role: 'packer' } });
});
after(() => t.stop());
beforeEach(() => {
  t.mail.sent.length = 0;
});

let n = 0;
async function register(email = `buyer${++n}@example.com`, name = 'Asha Rao') {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  call.email = email;
  return call;
}

const BOOK = 'the-quiet-engineer-paperback';
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
// A customer who has received the book and reviewed it with `rating` stars; returns { call, review }.
async function reviewer(rating, extra = {}) {
  const call = await register();
  const p = await t.db.collection('products').findOne({ slug: BOOK });
  const quote = await call('GET', `/cart?items=${p._id}:1`);
  const order = await call('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty: 1 }],
    address,
    expectedTotal: quote.body.total,
  });
  assert.equal(order.status, 201);
  for (const status of ['shipped', 'delivered']) {
    assert.equal((await admin('POST', `/admin/orders/${order.body.id}/status`, { status })).status, 200);
  }
  const res = await call('PUT', `/products/${BOOK}/review`, { rating, title: 'My view', body: 'Some words', ...extra });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { call, review: res.body };
}
const alerts = () => t.mail.sent.filter((m) => /-star review of/.test(m.subject));

test('a low review alerts the admins once; edits that stay low or go up do not', async () => {
  const { call, review } = await reviewer(1, { body: 'Pages fell out' });
  assert.equal(review.reply, null);
  const [alert] = alerts();
  assert.ok(alert, 'an alert was sent');
  assert.equal(alert.to.email, 'admin@example.com');
  assert.match(alert.subject, /^1-star review of The Quiet Engineer/);
  assert.match(alert.text, /Pages fell out/);
  assert.match(alert.text, /\/admin\/reviews\?status=reply/);

  t.mail.sent.length = 0;
  await call('PUT', `/products/${BOOK}/review`, { rating: 2, title: 'Still bad' });
  assert.equal(alerts().length, 0);
  await call('PUT', `/products/${BOOK}/review`, { rating: 4 });
  assert.equal(alerts().length, 0);
  // Down from 4 to 2 is new bad news.
  await call('PUT', `/products/${BOOK}/review`, { rating: 2 });
  assert.equal(alerts().length, 1);

  await reviewer(3);
  await reviewer(5);
  assert.equal(alerts().length, 1);
});

test('the store replies; the reviewer is emailed once and the product page shows it without the name', async () => {
  const { call, review } = await reviewer(2);
  const before = await t.db.collection('reviews').findOne({ title: 'My view', rating: 2 }, { sort: { _id: -1 } });
  t.mail.sent.length = 0;

  const res = await support('PUT', `/admin/reviews/${review.id}/reply`, {
    text: '  Sorry about that! We will replace it.  ',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.text, 'Sorry about that! We will replace it.');
  assert.equal(res.body.by, 'Sunil Support');
  const [email] = t.mail.sent;
  assert.equal(email.to.email, call.email);
  assert.match(email.subject, /We replied to your review of The Quiet Engineer/);
  assert.match(email.text, /Our reply: Sorry about that!/);
  assert.match(email.text, /\/p\/the-quiet-engineer-paperback#reviews/);

  // An edit changes the text, keeps the first time and sends nothing.
  t.mail.sent.length = 0;
  const edited = await admin('PUT', `/admin/reviews/${review.id}/reply`, { text: 'Sorry! A new copy is on its way.' });
  assert.equal(edited.body.at, res.body.at);
  assert.equal(edited.body.by, 'Store Admin');
  assert.equal(t.mail.sent.length, 0);

  // The review's own version (screening's) is untouched.
  const after = await t.db.collection('reviews').findOne({ _id: before._id });
  assert.deepEqual(after.updatedAt, before.updatedAt);

  const page = (await t.call('GET', `/products/${BOOK}/reviews`)).body;
  const shown = page.items.find((r) => r.id === review.id);
  assert.deepEqual(Object.keys(shown.reply).sort(), ['at', 'text', 'updatedAt']);
  assert.equal(shown.reply.text, 'Sorry! A new copy is on its way.');

  const actions = (await t.db.collection('activity').find({ area: 'reviews' }).toArray()).map((a) => a.action);
  assert.ok(actions.includes('Replied to a review'));
  assert.ok(actions.includes('Edited a reply'));

  // The customer edits their review afterwards: admins see it.
  await call('PUT', `/products/${BOOK}/review`, { rating: 4, title: 'Better now' });
  const list = (await admin('GET', '/admin/reviews')).body.items.find((r) => r.id === review.id);
  assert.equal(list.reply.reviewEditedSince, true);

  assert.equal((await admin('DELETE', `/admin/reviews/${review.id}/reply`)).status, 204);
  const gone = (await t.call('GET', `/products/${BOOK}/reviews`)).body.items.find((r) => r.id === review.id);
  assert.equal(gone.reply, null);
  assert.ok(await t.db.collection('activity').findOne({ action: 'Removed a reply' }));
  // Removing again is fine.
  assert.equal((await admin('DELETE', `/admin/reviews/${review.id}/reply`)).status, 204);
});

test('who may reply, and what a reply must be', async () => {
  const { call, review } = await reviewer(4);
  const path = `/admin/reviews/${review.id}/reply`;
  assert.equal((await t.call('PUT', path, { text: 'Hi' })).status, 401);
  assert.equal((await call('PUT', path, { text: 'Hi' })).status, 403);
  assert.equal((await packer('PUT', path, { text: 'Hi' })).status, 403);
  assert.equal((await admin('PUT', path, { text: '   ' })).status, 400);
  assert.equal((await admin('PUT', path, { text: 'x'.repeat(1001) })).status, 400);
  assert.equal((await admin('PUT', '/admin/reviews/0123456789abcdef01234567/reply', { text: 'Hi' })).status, 404);
  assert.equal((await admin('DELETE', '/admin/reviews/0123456789abcdef01234567/reply')).status, 404);
  assert.equal((await admin('PUT', '/admin/reviews/nope/reply', { text: 'Hi' })).status, 400);
});

test('low reviews without a reply are listed as needing one, and counted on the dashboard', async () => {
  const { review: low } = await reviewer(1);
  const { review: high } = await reviewer(5);
  let list = (await admin('GET', '/admin/reviews?status=reply')).body;
  const ids = list.items.map((r) => r.id);
  assert.ok(ids.includes(low.id));
  assert.ok(!ids.includes(high.id));
  assert.equal(list.counts.reply, list.total);
  assert.equal((await admin('GET', '/admin/dashboard')).body.reviewsToReply, list.total);

  await admin('PUT', `/admin/reviews/${low.id}/reply`, { text: 'We are sorry.' });
  list = (await admin('GET', '/admin/reviews?status=reply')).body;
  assert.ok(!list.items.some((r) => r.id === low.id));

  // A hidden low review doesn't need one.
  const { review: other } = await reviewer(2);
  await admin('POST', `/admin/reviews/${other.id}/visibility`, { hidden: true });
  list = (await admin('GET', '/admin/reviews?status=reply')).body;
  assert.ok(!list.items.some((r) => r.id === other.id));
});
