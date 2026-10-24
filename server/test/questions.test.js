import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let asha;
let ravi;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'Store Admin');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  asha = await register('asha@example.com', 'Asha Rao');
  ravi = await register('ravi@example.com', 'Ravi Kumar');
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}

const SLUG = 'stride-running-shoes';
const ask = (who, text, slug = SLUG) => who('POST', `/products/${slug}/questions`, { text });
const page = (who = t.call, slug = SLUG) => who('GET', `/products/${slug}/questions`);
const answersTo = (email) => t.mail.sent.filter((m) => m.to.email === email && m.subject.startsWith('Your question'));

test('a customer asks; only they see it until it is answered', async () => {
  assert.equal((await ask(t.call, 'Do these run large?')).status, 401);
  const res = await ask(asha, '  Do these run large?  ');
  assert.equal(res.status, 201);
  assert.deepEqual(
    { ...res.body, id: undefined, createdAt: undefined },
    { id: undefined, text: 'Do these run large?', author: 'Asha R.', createdAt: undefined, answer: null },
  );

  assert.deepEqual((await page()).body.items, []);
  assert.deepEqual((await page()).body.waiting, []);
  assert.deepEqual((await page(ravi)).body.waiting, []);
  const mine = await page(asha);
  assert.deepEqual(mine.body.items, []);
  assert.deepEqual(
    mine.body.waiting.map((q) => q.text),
    ['Do these run large?'],
  );
});

test('questions are checked: length, hidden products, and how many an hour', async () => {
  assert.match((await ask(asha, 'Hi?')).body.error, /at least 5 characters/);
  assert.match((await ask(asha, 'x'.repeat(501))).body.error, /At most 500/);
  await t.db.collection('products').updateOne({ slug: 'bolt-bass-neckband' }, { $set: { active: false } });
  assert.equal((await ask(asha, 'Is it waterproof?', 'bolt-bass-neckband')).status, 404);
  await t.db.collection('products').updateOne({ slug: 'bolt-bass-neckband' }, { $set: { active: true } });

  // Ravi has asked none yet: five go through, the sixth waits an hour.
  for (let i = 1; i <= 5; i++) assert.equal((await ask(ravi, `Question number ${i}?`)).status, 201);
  const sixth = await ask(ravi, 'Question number 6?');
  assert.equal(sixth.status, 429);
  assert.match(sixth.body.error, /5 questions an hour/);
});

test('askers delete their own unanswered questions, nobody else’s', async () => {
  const q = (await ask(admin, 'A question to delete?')).body;
  assert.equal((await asha('DELETE', `/questions/${q.id}`)).status, 404);
  assert.equal((await t.call('DELETE', `/questions/${q.id}`)).status, 401);
  assert.equal((await admin('DELETE', `/questions/${q.id}`)).status, 204);
  assert.equal((await admin('DELETE', `/questions/${q.id}`)).status, 404);
});

test('admins list unanswered questions oldest first, with who asked', async () => {
  assert.equal((await asha('GET', '/admin/questions')).status, 403);
  const res = await admin('GET', '/admin/questions');
  assert.equal(res.status, 200);
  assert.equal(res.body.items[0].text, 'Do these run large?');
  assert.deepEqual(res.body.items[0].customer, { name: 'Asha Rao', email: 'asha@example.com' });
  assert.equal(res.body.items[0].product.slug, SLUG);
  assert.deepEqual(res.body.counts, { unanswered: 6, answered: 0, hidden: 0 });
  assert.equal((await admin('GET', '/admin/dashboard')).body.questionsToAnswer, 6);
});

test('answering puts it on the product page and emails the asker once; edits keep its place', async () => {
  const [q] = (await admin('GET', '/admin/questions')).body.items;
  assert.equal((await asha('PUT', `/admin/questions/${q.id}/answer`, { text: 'Yes' })).status, 403);
  assert.match((await admin('PUT', `/admin/questions/${q.id}/answer`, { text: '  ' })).body.error, /Write the answer/);

  const res = await admin('PUT', `/admin/questions/${q.id}/answer`, { text: 'They run true to size.' });
  assert.equal(res.status, 200);
  assert.equal(res.body.answer.text, 'They run true to size.');
  const shown = (await page()).body;
  assert.equal(shown.total, 1);
  assert.equal(shown.items[0].answer.text, 'They run true to size.');
  assert.deepEqual((await page(asha)).body.waiting, []);

  const mails = answersTo('asha@example.com');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, 'Your question about Stride Running Shoes was answered');
  assert.ok(mails[0].text.includes('You asked: Do these run large?'));
  assert.ok(mails[0].text.includes('Our answer: They run true to size.'));
  assert.ok(mails[0].text.includes('https://bazaar.test/p/stride-running-shoes#questions'));

  // An edit: no second email; the first answer's time stays; text with $ is kept as typed.
  const firstAt = shown.items[0].answer.at;
  await admin('PUT', `/admin/questions/${q.id}/answer`, { text: '$5 cheaper online, and true to size.' });
  const edited = (await page()).body.items[0];
  assert.equal(edited.answer.text, '$5 cheaper online, and true to size.');
  assert.equal(edited.answer.at, firstAt);
  assert.equal(answersTo('asha@example.com').length, 1);

  const log = (await admin('GET', '/admin/activity?area=questions')).body.items;
  assert.deepEqual(
    log.map((e) => e.action),
    ['Changed answer', 'Answered question'],
  );
  assert.equal(log[0].target.label, 'Stride Running Shoes: “Do these run large?”');
  assert.equal((await asha('DELETE', `/questions/${q.id}`)).status, 409);
  assert.equal((await admin('GET', '/admin/dashboard')).body.questionsToAnswer, 5);
});

test('hiding takes a question off the page and out of the waiting list', async () => {
  const [answered] = (await admin('GET', '/admin/questions?status=answered')).body.items;
  const hide = await admin('POST', `/admin/questions/${answered.id}/visibility`, { hidden: true });
  assert.equal(hide.status, 200);
  assert.equal(hide.body.hidden, true);
  assert.equal((await page()).body.total, 0);
  assert.deepEqual((await admin('GET', '/admin/questions')).body.counts, { unanswered: 5, answered: 0, hidden: 1 });
  assert.equal((await admin('GET', '/admin/activity?area=questions')).body.items[0].action, 'Hid question');

  await admin('POST', `/admin/questions/${answered.id}/visibility`, { hidden: false });
  assert.equal((await page()).body.total, 1);
  assert.equal(
    (await admin('POST', '/admin/questions/0123456789abcdef01234567/visibility', { hidden: true })).status,
    404,
  );
});
