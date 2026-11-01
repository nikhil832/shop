import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// Size fit from reviews (stage 137).
let t;
let admin;
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
});
after(() => t.stop());

const SHOES = 'stride-running-shoes'; // sizes UK 7–10
const BAG = 'ziva-women-handbag'; // colours only
const BOOK = 'the-quiet-engineer-paperback'; // no options
const product = (slug) => t.db.collection('products').findOne({ slug });

// A customer who received `slug`, logged in.
let n = 0;
async function buyer(slug) {
  const call = t.browser();
  n += 1;
  await call('POST', '/auth/register', {
    name: `Buyer ${n} Rao`,
    email: `buyer${n}@example.com`,
    password: 'password123',
  });
  const user = await t.db.collection('users').findOne({ email: `buyer${n}@example.com` });
  const p = await product(slug);
  await t.db.collection('orders').insertOne({
    userId: user._id,
    items: [{ productId: p._id, title: p.title, price: p.price, qty: 1 }],
    subtotal: p.price,
    delivery: 0,
    discount: 0,
    total: p.price,
    status: 'delivered',
    payment: { method: 'cod' },
    createdAt: new Date(),
    deliveredAt: new Date(),
  });
  return call;
}
const review = (call, slug, body) => call('PUT', `/products/${slug}/review`, { rating: 4, ...body });
const fitOf = async (slug) => (await t.call('GET', `/products/${slug}`)).body.sizeFit;

test('reviewers of a product with sizes say how it fits; the product shows it from three answers', async () => {
  assert.equal(await fitOf(SHOES), null);
  const a = await buyer(SHOES);
  const saved = await review(a, SHOES, { fit: 'small' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.fit, 'small');
  await review(await buyer(SHOES), SHOES, { fit: 'true' });
  await review(await buyer(SHOES), SHOES, {}); // didn't say
  assert.equal(await fitOf(SHOES), null); // two answers

  await review(await buyer(SHOES), SHOES, { fit: 'true' });
  assert.deepEqual(await fitOf(SHOES), { small: 1, true: 2, large: 0, total: 3, verdict: 'true' });
  const list = (await t.call('GET', `/products/${SHOES}/reviews`)).body.items;
  assert.deepEqual(list.map((r) => r.fit).sort(), [null, 'small', 'true', 'true']);

  // Split: no answer has half.
  await review(await buyer(SHOES), SHOES, { fit: 'large' });
  await review(await buyer(SHOES), SHOES, { fit: 'large' });
  assert.deepEqual(await fitOf(SHOES), { small: 1, true: 2, large: 2, total: 5, verdict: null });

  // An edit that leaves fit out keeps it; null clears it.
  await review(a, SHOES, { title: 'Comfy' });
  assert.equal((await t.db.collection('reviews').findOne({ title: 'Comfy' })).fit, 'small');
  await review(a, SHOES, { fit: null });
  assert.deepEqual(await fitOf(SHOES), { small: 0, true: 2, large: 2, total: 4, verdict: 'true' });

  // Hidden reviews leave it.
  const hide = await t.db.collection('reviews').findOne({ fit: 'large' });
  const res = await admin('POST', `/admin/reviews/${hide._id}/visibility`, { hidden: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(await fitOf(SHOES), { small: 0, true: 2, large: 1, total: 3, verdict: 'true' });
});

test('only products with sizes take a fit, and only the three answers', async () => {
  const bag = await buyer(BAG);
  const refused = await review(bag, BAG, { fit: 'true' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /no sizes/);
  assert.equal((await review(bag, BAG, { fit: null })).status, 200);
  assert.equal(await fitOf(BAG), null);
  assert.equal((await review(await buyer(BOOK), BOOK, { fit: 'small' })).status, 400);
  assert.equal(await fitOf(BOOK), null);

  const shoes = await buyer(SHOES);
  for (const bad of ['tight', 'TRUE', 3]) assert.equal((await review(shoes, SHOES, { fit: bad })).status, 400, bad);
});
