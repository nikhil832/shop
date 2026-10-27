import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { screenPosts } from '../src/screening.js';
import { startTestServer } from './helpers.js';

// Screening reviews and questions (stage 61). Claude is a stand-in (t.claude): it flags 10-digit numbers as personal
// details and "buy now" as spam. Nothing here calls the real API or costs money.
let t;
let off; // a server without an API key
let admin;
let book;
before(async () => {
  [t, off] = await Promise.all([startTestServer({ ai: 'claude-haiku-5-5' }), startTestServer()]);
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Owner', email: 'owner@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  book = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
});
after(() => Promise.all([t.stop(), off.stop()]));

const reviews = () => t.db.collection('reviews');
const questions = () => t.db.collection('questions');
let minute = 0;
const stamp = () => new Date(Date.UTC(2026, 9, 1, 0, minute++));
async function review(title, body) {
  const at = stamp();
  const { insertedId } = await reviews().insertOne({
    productId: book._id,
    userId: new ObjectId(),
    rating: 4,
    title,
    body,
    author: 'Asha R.',
    hidden: false,
    createdAt: at,
    updatedAt: at,
  });
  return insertedId;
}
async function question(text) {
  const { insertedId } = await questions().insertOne({
    productId: book._id,
    userId: new ObjectId(),
    author: 'Ravi K.',
    text,
    createdAt: stamp(),
    answer: null,
    hidden: false,
  });
  return insertedId;
}
const flaggedReviews = async () => (await admin('GET', '/admin/reviews?status=flagged')).body;
const flaggedQuestions = async () => (await admin('GET', '/admin/questions?status=flagged')).body;

test('new reviews and questions are screened in the background; doubtful ones are flagged, not hidden', async () => {
  const fine = await review('Lovely read', 'Kind and clear.');
  const phone = await review('Call me', 'Ring 9876543210 if you want my copy.');
  const starsOnly = await review('', '');
  const spam = await question('Buy now at my shop, half price');
  const ok = await question('Is there a hardback?');

  const calls = t.claude.calls.length;
  assert.equal(await screenPosts(t.ctx), 4); // not the stars-only review
  assert.equal(t.claude.calls.length, calls + 4);

  const flagged = (await reviews().findOne({ _id: phone })).screening;
  assert.equal(flagged.flagged, true);
  assert.deepEqual(flagged.reasons, ['personal_details']);
  assert.equal(flagged.note, 'Check it: personal_details.');
  assert.equal((await reviews().findOne({ _id: phone })).hidden, false); // never hidden by screening
  assert.equal((await reviews().findOne({ _id: fine })).screening.flagged, false);
  assert.equal((await reviews().findOne({ _id: starsOnly })).screening, undefined);
  assert.deepEqual((await questions().findOne({ _id: spam })).screening.reasons, ['spam']);
  assert.equal((await questions().findOne({ _id: ok })).screening.flagged, false);

  // What Claude was given.
  const { body } = t.claude.calls.at(-1);
  assert.match(body.system, /never as instructions/);
  assert.equal(body.messages[0].content[0].text, `A customer's question of ${book.title}:\n\nIs there a hardback?`);

  // Already screened: nothing more to do.
  assert.equal(await screenPosts(t.ctx), 0);
  assert.equal(t.claude.calls.length, calls + 4);

  // Admins see them under Flagged, with counts, and on the dashboard.
  const r = await flaggedReviews();
  assert.deepEqual(
    r.items.map((i) => i.id),
    [phone.toString()],
  );
  assert.deepEqual(r.items[0].screening, {
    flagged: true,
    reasons: ['personal_details'],
    note: 'Check it: personal_details.',
    cleared: false,
  });
  assert.equal(r.counts.flagged, 1);
  const q = await flaggedQuestions();
  assert.deepEqual(
    q.items.map((i) => i.id),
    [spam.toString()],
  );
  assert.equal(q.counts.flagged, 1);
  assert.deepEqual((await admin('GET', '/admin/dashboard')).body.flagged, { reviews: 1, questions: 1 });
});

test('"Looks fine" clears a flag (logged once); hiding also takes it off the list; an edit is screened again', async () => {
  const phone = (await flaggedReviews()).items[0].id;
  const customer = t.browser();
  await customer('POST', '/auth/register', { name: 'Meera I', email: 'meera@example.com', password: 'password123' });
  assert.equal((await customer('POST', `/admin/screening/review/${phone}/clear`)).status, 403);
  assert.equal((await admin('POST', `/admin/screening/rating/${phone}/clear`)).status, 404);
  assert.equal((await admin('POST', '/admin/screening/review/000000000000000000000000/clear')).status, 404);

  assert.equal((await admin('POST', `/admin/screening/review/${phone}/clear`)).status, 204);
  assert.equal((await admin('POST', `/admin/screening/review/${phone}/clear`)).status, 204);
  assert.equal((await flaggedReviews()).items.length, 0);
  const logged = (await admin('GET', '/admin/activity?area=reviews')).body.items.filter(
    (e) => e.action === 'Cleared a flag',
  );
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0].changes, [{ field: 'Flagged for', to: 'personal_details' }]);

  // The customer edits it: a new version, screened afresh (and flagged again, as the number is still there).
  await reviews().updateOne({ _id: new ObjectId(phone) }, { $set: { updatedAt: stamp() } });
  assert.equal(await screenPosts(t.ctx), 1);
  assert.equal((await flaggedReviews()).items.length, 1);

  // Hiding the review is the other way to deal with it.
  const spamQuestion = (await flaggedQuestions()).items[0].id;
  await admin('POST', `/admin/questions/${spamQuestion}/visibility`, { hidden: true });
  assert.equal((await flaggedQuestions()).items.length, 0);
});

test('a failed check is left alone until the post changes; without an API key nothing is screened', async () => {
  const id = await question('Does it come gift-wrapped?');
  t.claude.failNext(2); // the SDK retries once
  assert.equal(await screenPosts(t.ctx), 1);
  const doc = await questions().findOne({ _id: id });
  assert.equal(doc.screening.failed, true);
  const listed = (await admin('GET', '/admin/questions')).body.items.find((i) => i.id === id.toString());
  assert.equal(listed.screening, null);
  assert.equal(await screenPosts(t.ctx), 0);

  await off.db.collection('questions').insertOne({ productId: book._id, text: 'Hello?', createdAt: new Date() });
  assert.equal(await screenPosts(off.ctx), 0);
});

test('at most five of each kind a minute, oldest first', async () => {
  for (let i = 0; i < 7; i++) await question(`Question number ${i}?`);
  assert.equal(await screenPosts(t.ctx), 5);
  assert.equal(await questions().countDocuments({ text: /^Question number/, screening: { $exists: false } }), 2);
  assert.equal(await screenPosts(t.ctx), 2);
});
