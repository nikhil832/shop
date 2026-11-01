import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { startTestServer } from './helpers.js';
import { payReviewRewards } from '../src/reviewRewards.js';

// Review rewards (stage 145).
let t;
let admin;
let ashaId;
let since;
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  const asha = t.browser();
  await asha('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
  ashaId = (await t.db.collection('users').findOne({ email: 'asha@example.com' }))._id;
});
after(() => t.stop());
beforeEach(() => {
  t.mail.sent.length = 0;
});

const DAY = 86_400_000;
const ON = { enabled: true, amount: 2000, minChars: 50, monthlyCap: 5 };
const WORDS = 'Sturdy, comfortable and exactly as pictured. Would buy it again for sure.';
const product = (slug) => t.db.collection('products').findOne({ slug });
// A shown review by Asha, written `minutes` after rewards were switched on.
async function review(slug, changes = {}, minutes = 1) {
  const p = await product(slug);
  const doc = {
    _id: new ObjectId(),
    productId: p._id,
    userId: ashaId,
    author: 'Asha R.',
    rating: 5,
    title: '',
    body: WORDS,
    photos: ['/api/images/0123456789abcdef01234567'],
    hidden: false,
    helpful: 0,
    createdAt: new Date(since.getTime() + minutes * 60_000),
    ...changes,
  };
  await t.db.collection('reviews').insertOne(doc);
  return doc;
}
const reviewDoc = (doc) => t.db.collection('reviews').findOne({ _id: doc._id });
const credit = async () => (await t.db.collection('users').findOne({ _id: ashaId })).credit ?? 0;
const later = (days) => new Date(since.getTime() + days * DAY);

test('admins switch it on; the settings are checked and logged; the review form learns of it', async () => {
  assert.equal((await t.call('GET', '/review-rewards')).body, null);
  for (const bad of [
    { ...ON, amount: 2050 },
    { ...ON, amount: 60000 },
    { ...ON, monthlyCap: 0 },
  ]) {
    assert.equal((await admin('PUT', '/admin/review-rewards', bad)).status, 400, JSON.stringify(bad));
  }
  const res = await admin('PUT', '/admin/review-rewards', ON);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  since = new Date(res.body.since);
  assert.deepEqual((await t.call('GET', '/review-rewards')).body, { amount: 2000, minChars: 50, settleDays: 3 });
  const log = await t.db.collection('activity').findOne({ action: 'Changed review rewards' });
  assert.equal(log.changes[0].to, '₹20 for a review with a photo and 50+ characters, up to 5 a month');
});

test('a review with a photo and words is paid after 3 days shown, once, with an email', async () => {
  const good = await review('stride-running-shoes');
  const old = await review('the-quiet-engineer-paperback', {}, -60); // written before rewards were on
  const short = await review('ziva-women-handbag', { body: 'Nice.' });
  const noPhoto = await review('ziva-analog-watch', { photos: [] });
  const hidden = await review('learning-to-code-with-javascript', { hidden: true });

  assert.equal(await payReviewRewards(t.ctx, later(2)), 0); // not 3 days yet
  assert.equal(await payReviewRewards(t.ctx, later(4)), 1);
  assert.equal(await payReviewRewards(t.ctx, later(4)), 0); // once
  assert.equal(await credit(), 2000);
  assert.equal((await reviewDoc(good)).reward.amount, 2000);
  for (const doc of [old, short, noPhoto, hidden]) assert.equal((await reviewDoc(doc)).reward, undefined);
  const entry = await t.db.collection('creditLedger').findOne({ userId: ashaId, reason: 'review' });
  assert.equal(entry.change, 2000);
  assert.equal(entry.note, 'Stride Running Shoes');
  const [mail] = t.mail.sent;
  assert.equal(mail.subject, '₹20 store credit for your review');
  assert.match(mail.text, /Thank you for reviewing Stride Running Shoes with a photo/);

  // Deleted and written again: the same product earns nothing more.
  await t.db.collection('reviews').deleteOne({ _id: good._id });
  const again = await review('stride-running-shoes', {}, 2);
  assert.equal(await payReviewRewards(t.ctx, later(5)), 0);
  assert.equal((await reviewDoc(again)).reward.amount, 0);
  assert.equal(await credit(), 2000);
});

test('the monthly cap holds; with screening on, only screened, unflagged reviews are paid', async () => {
  await admin('PUT', '/admin/review-rewards', { ...ON, monthlyCap: 1 });
  const capped = await review('voltix-nova-5g-8gb-ram-128gb', {}, 3);
  assert.equal(await payReviewRewards(t.ctx, later(5)), 0);
  assert.equal((await reviewDoc(capped)).reward, undefined);

  await admin('PUT', '/admin/review-rewards', ON);
  const withAi = { ...t.ctx, ai: {} };
  const version = capped.createdAt;
  // Not screened yet: waits.
  assert.equal(await payReviewRewards(withAi, later(5)), 0);
  await t.db
    .collection('reviews')
    .updateOne({ _id: capped._id }, { $set: { screening: { of: version, flagged: true, reasons: ['spam'] } } });
  assert.equal(await payReviewRewards(withAi, later(5)), 0); // flagged
  await t.db.collection('reviews').updateOne({ _id: capped._id }, { $set: { 'screening.cleared': true } });
  assert.equal(await payReviewRewards(withAi, later(5)), 1); // cleared by an admin
  assert.equal(await credit(), 4000);

  // Switched off: nothing.
  await admin('PUT', '/admin/review-rewards', { ...ON, enabled: false });
  await review('orbit-a14-4gb-ram-64gb', {}, 4);
  assert.equal(await payReviewRewards(t.ctx, later(6)), 0);
});
