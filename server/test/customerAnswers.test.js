import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { startTestServer } from './helpers.js';
import { MAX_CUSTOMER_ANSWERS } from '../src/routes/questions.js';

let t;
let admin;
let asker;
let buyer;
let buyer2;
let stranger;
const SLUG = 'the-quiet-engineer-paperback';
const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};

async function register(email, name = 'Asha Rao') {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  call.email = email;
  return call;
}
// Buys the book and has the admin deliver it.
async function buyAndReceive(call) {
  const book = await t.db.collection('products').findOne({ slug: SLUG });
  const quote = await call('GET', `/cart?items=${book._id}:1`);
  const order = await call('POST', '/orders', {
    items: [{ productId: book._id.toString(), qty: 1 }],
    address,
    expectedTotal: quote.body.total,
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  for (const status of ['shipped', 'delivered']) {
    assert.equal((await admin('POST', `/admin/orders/${order.body.id}/status`, { status })).status, 200);
  }
}
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'Store Admin');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  asker = await register('asker@example.com', 'Meera Iyer');
  buyer = await register('buyer@example.com', 'Ravi Kumar');
  buyer2 = await register('buyer2@example.com', 'Kavya Nair');
  stranger = await register('stranger@example.com', 'Tara Sen');
  await buyAndReceive(buyer);
  await buyAndReceive(buyer2);
});
after(() => t.stop());

const page = (who) => who('GET', `/products/${SLUG}/questions`);
const ask = async (text) => (await asker('POST', `/products/${SLUG}/questions`, { text })).body;
const answer = (who, q, text) => who('POST', `/questions/${q.id}/answers`, { text });
const mailsTo = (email) => t.mail.sent.filter((m) => m.to.email === email && m.subject.startsWith('Your question'));

test('a buyer answers a waiting question; it shows as "bought this", and the asker hears once', async () => {
  const q = await ask('Is the paper thick enough for highlighters?');
  // Only buyers are offered it, and only buyers can answer.
  const offered = (await page(buyer)).body;
  assert.equal(offered.canAnswer, true);
  assert.ok(offered.open.some((o) => o.id === q.id));
  assert.equal((await page(stranger)).body.canAnswer, false);
  assert.deepEqual((await page(stranger)).body.open, []);
  assert.equal((await answer(stranger, q, 'No idea')).status, 403);
  assert.equal((await answer(t.call, q, 'No idea')).status, 401);

  const res = await answer(buyer, q, '  Yes, no bleed-through with mine.  ');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(
    res.body.customerAnswers.map((a) => [a.author, a.text]),
    [['Ravi K.', 'Yes, no bleed-through with mine.']],
  );
  // On the product page now, though the store hasn't answered; no longer "waiting" for the asker, nor open for him.
  const shop = (await page(t.call)).body;
  assert.ok(shop.items.some((i) => i.id === q.id && i.answer === null && i.customerAnswers.length === 1));
  assert.ok(!(await page(asker)).body.waiting.some((w) => w.id === q.id));
  assert.ok(!(await page(buyer)).body.open.some((o) => o.id === q.id));
  const [mail] = mailsTo(asker.email);
  assert.match(mail.text, /A customer who bought it answered: Yes, no bleed-through with mine\./);

  // Once each; the second buyer's goes after it; the asker isn't emailed again.
  assert.equal((await answer(buyer, q, 'Again')).status, 409);
  assert.equal((await answer(buyer2, q, 'Fine with gel pens too.')).status, 201);
  assert.equal(mailsTo(asker.email).length, 1);
  assert.equal((await answer(asker, q, 'Answering myself')).status, 400);
});

test("the store's answer stays first, and the asker is told about it too", async () => {
  const q = await ask('Is there an index at the back?');
  await answer(buyer, q, 'Yes, a short one.');
  const before = mailsTo(asker.email).length;
  assert.equal((await admin('PUT', `/admin/questions/${q.id}/answer`, { text: 'Yes, eight pages.' })).status, 200);
  const shown = (await page(t.call)).body.items.find((i) => i.id === q.id);
  assert.equal(shown.answer.text, 'Yes, eight pages.');
  assert.deepEqual(
    shown.customerAnswers.map((a) => a.text),
    ['Yes, a short one.'],
  );
  assert.equal(mailsTo(asker.email).length, before + 1);
  // Answered by the store: no longer offered to buyers.
  assert.ok(!(await page(buyer2)).body.open.some((o) => o.id === q.id));
});

test('admins hide a customer answer; a question with no other answer leaves the page', async () => {
  const q = await ask('Does it come with a bookmark?');
  const posted = (await answer(buyer, q, 'Buy it at shop dot example now')).body;
  const answerId = posted.customerAnswers[0].id;
  const path = `/admin/questions/${q.id}/customer-answers/${answerId}/visibility`;
  assert.equal((await buyer('POST', path, { hidden: true })).status, 403);
  const hid = await admin('POST', path, { hidden: true });
  assert.equal(hid.status, 200, JSON.stringify(hid.body));
  assert.equal(hid.body.customerAnswers[0].hidden, true);
  assert.ok(!(await page(t.call)).body.items.some((i) => i.id === q.id));
  const log = await t.db.collection('activity').findOne({ action: "Hid a customer's answer" });
  assert.ok(log);
  assert.equal((await admin('POST', path, { hidden: false })).status, 200);
  assert.ok((await page(t.call)).body.items.some((i) => i.id === q.id));
  assert.equal(
    (await admin('POST', `/admin/questions/${q.id}/customer-answers/${new ObjectId()}/visibility`, { hidden: true }))
      .status,
    404,
  );
});

test('answers are checked, and a question takes at most ten', async () => {
  const q = await ask('Is it a first edition?');
  assert.equal((await answer(buyer, q, 'x')).status, 400);
  assert.equal((await answer(buyer, q, 'x'.repeat(501))).status, 400);
  const others = Array.from({ length: MAX_CUSTOMER_ANSWERS }, (_, i) => ({
    _id: new ObjectId(),
    userId: new ObjectId(),
    author: `Someone ${i}`,
    text: 'Yes',
    at: new Date(),
    hidden: false,
  }));
  await t.db.collection('questions').updateOne({ _id: new ObjectId(q.id) }, { $set: { customerAnswers: others } });
  const full = await answer(buyer, q, 'Mine too');
  assert.equal(full.status, 409);
  assert.match(full.body.error, /enough answers/);
});

test("closing an account removes its answers, keeps others' answered questions, and the download lists them", async () => {
  const q = await ask('Is the cover matte or glossy?');
  await answer(buyer2, q, 'Matte, and it scuffs a little.');
  const data = (await buyer2('GET', '/account/data')).body;
  assert.ok(data.answersGiven.some((a) => a.answer === 'Matte, and it scuffs a little.'));

  assert.equal((await buyer2('POST', '/account/close', { password: 'password123', confirm: true })).status, 204);
  const doc = await t.db.collection('questions').findOne({ _id: new ObjectId(q.id) });
  assert.ok(!doc.customerAnswers.some((a) => a.text.startsWith('Matte')));

  // The asker closing keeps a question others answered, signed "A customer". (Another asker: five questions an hour.)
  const kept = (await stranger('POST', `/products/${SLUG}/questions`, { text: 'Does it have illustrations?' })).body;
  const keptAnswer = await answer(buyer, kept, 'A few diagrams.');
  assert.equal(keptAnswer.status, 201, JSON.stringify(keptAnswer.body));
  assert.equal((await stranger('POST', '/account/close', { password: 'password123', confirm: true })).status, 204);
  const left = await t.db.collection('questions').findOne({ _id: new ObjectId(kept.id) });
  assert.equal(left.author, 'A customer');
  assert.equal(left.customerAnswers.length, 1);
});
