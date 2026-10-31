import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { MAX_FAQS } from '../src/faq.js';

let t;
let admin;
let support;
let customer;
async function register(email, role) {
  const call = t.browser();
  await call('POST', '/auth/register', { name: 'Asha Rao', email, password: 'password123' });
  if (role) await t.db.collection('users').updateOne({ email }, { $set: { role } });
  return call;
}
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'admin');
  support = await register('support@example.com', 'support');
  customer = await register('asha@example.com');
});
after(() => t.stop());

const add = (call, body) =>
  call('POST', '/admin/faq', {
    topic: 'delivery',
    answer: 'Free from ₹499.',
    question: 'How much is delivery?',
    ...body,
  });
const questions = (body) => body.topics.flatMap((g) => g.items.map((i) => i.question));

test('the shop lists shown questions by topic, in order', async () => {
  assert.deepEqual((await t.call('GET', '/faq')).body, { topics: [] });
  const a = await add(admin, { question: 'How much is delivery?' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  await add(admin, { question: 'Can I pay on delivery?', topic: 'payment' });
  await add(admin, { question: 'When will my order arrive?' });
  await add(admin, { question: 'A draft we are not showing', active: false });

  const shop = (await t.call('GET', '/faq')).body;
  assert.deepEqual(
    shop.topics.map((g) => g.label),
    ['Delivery', 'Payment'],
  );
  assert.deepEqual(questions(shop), ['How much is delivery?', 'When will my order arrive?', 'Can I pay on delivery?']);
  assert.deepEqual(Object.keys(shop.topics[0].items[0]).sort(), ['answer', 'id', 'question', 'topic']);

  // Moving a question up swaps it with the one above; the first can't go higher.
  const second = shop.topics[0].items[1];
  assert.equal((await admin('POST', `/admin/faq/${second.id}/move`, { direction: 'up' })).status, 204);
  assert.equal((await admin('POST', `/admin/faq/${second.id}/move`, { direction: 'up' })).status, 204);
  assert.deepEqual(questions((await t.call('GET', '/faq')).body).slice(0, 2), [
    'When will my order arrive?',
    'How much is delivery?',
  ]);
});

test('admins and support staff edit and delete; customers cannot; changes are logged', async () => {
  const made = (await add(support, { question: 'Do you deliver on Sundays?' })).body;
  assert.equal((await add(customer, {})).status, 403);
  assert.equal((await t.call('POST', '/admin/faq', {})).status, 401);

  const edited = await support('PUT', `/admin/faq/${made.id}`, {
    question: 'Do you deliver on Sundays?',
    answer: 'Not yet.\n\nWe deliver Monday to Saturday.',
    topic: 'other',
    active: true,
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.topic, 'other');
  const listed = (await admin('GET', '/admin/faq')).body;
  assert.equal(
    listed.topics.find((g) => g.topic === 'other').items[0].answer,
    'Not yet.\n\nWe deliver Monday to Saturday.',
  );
  assert.equal(listed.max, MAX_FAQS);

  assert.equal((await admin('DELETE', `/admin/faq/${made.id}`)).status, 204);
  assert.equal((await admin('DELETE', `/admin/faq/${made.id}`)).status, 404);
  const log = await t.db.collection('activity').find({ area: 'help' }).sort({ at: 1 }).toArray();
  assert.deepEqual(
    log.slice(-3).map((e) => [e.action, e.target.label]),
    [
      ['Added a FAQ', 'Do you deliver on Sundays?'],
      ['Edited a FAQ', 'Do you deliver on Sundays?'],
      ['Deleted a FAQ', 'Do you deliver on Sundays?'],
    ],
  );
  assert.deepEqual(
    log.at(-2).changes.map((c) => c.field),
    ['Answer', 'Topic'],
  );
});

test('questions and answers are checked', async () => {
  const bad = async (body, pattern) => {
    const res = await add(admin, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, pattern);
  };
  await bad({ question: 'Hm?' }, /Write the question/);
  await bad({ question: 'x'.repeat(151) }, /150 characters/);
  await bad({ answer: 'x'.repeat(1501) }, /1,500 characters/);
  await bad({ topic: 'weather' }, /Choose a topic/);
  assert.equal(
    (
      await admin('PUT', '/admin/faq/0123456789abcdef01234567', {
        question: 'Any question?',
        answer: 'ok',
        topic: 'other',
      })
    ).status,
    404,
  );
});
