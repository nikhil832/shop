import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { AI_DRAFTS_PER_HOUR } from '../src/routes/aiWriter.js';

// The writing assistant talks to a stand-in Claude API (t.claude): nothing here calls the real one or costs money.
let t;
let off; // a server without an API key
let admin;
let categoryId;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function adminOf(server) {
  const call = server.browser();
  await call('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await server.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  return call;
}

before(async () => {
  [t, off] = await Promise.all([startTestServer({ ai: 'claude-opus-5-5' }), startTestServer()]);
  admin = await adminOf(t);
  categoryId = (await t.db.collection('categories').findOne({ name: 'Home & Kitchen' }))._id.toString();
});
after(() => Promise.all([t.stop(), off.stop()]));

const draft = (body) =>
  admin('POST', '/admin/ai/product-draft', { title: 'Griha Ceramic Vase', brand: 'Griha', categoryId, ...body });

test('only admins can ask, and the form learns whether the assistant is on', async () => {
  assert.equal((await t.call('GET', '/admin/ai')).status, 401);
  const customer = t.browser();
  await customer('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
  assert.equal((await customer('POST', '/admin/ai/product-draft', {})).status, 403);
  assert.deepEqual((await admin('GET', '/admin/ai')).body, { enabled: true, model: 'claude-opus-5-5' });

  const offAdmin = await adminOf(off);
  assert.deepEqual((await offAdmin('GET', '/admin/ai')).body, { enabled: false, model: null });
  const refused = await offAdmin('POST', '/admin/ai/product-draft', { title: 'Vase', brand: 'Griha', categoryId });
  assert.equal(refused.status, 503);
  assert.match(refused.body.error, /ANTHROPIC_API_KEY/);
});

test('drafts a description and highlights from the title, brand, category, facts and photo', async () => {
  const photo = await admin('POST', '/admin/images', PNG, 'image/png');
  const before = t.claude.calls.length;
  const res = await draft({ facts: ['Hand-glazed', '25 cm tall'], image: photo.body.url });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // Highlights come back trimmed and without full stops.
  assert.deepEqual(res.body, {
    description: 'Griha Ceramic Vase is a dependable pick for everyday use.\n\nMade to last, and easy to look after.',
    highlights: ['Easy to use', 'Built to last', 'Great value'],
  });

  assert.equal(t.claude.calls.length, before + 1);
  const { body, headers } = t.claude.calls.at(-1);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.output_config.format.type, 'json_schema');
  // Opus can pass a declined request on to another model.
  assert.equal(body.fallbacks, 'default');
  assert.match(headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  const [image, text] = body.messages[0].content;
  assert.deepEqual(image.source, { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') });
  assert.equal(
    text.text,
    'Title: Griha Ceramic Vase\nBrand: Griha\nCategory: Home & Kitchen\nFacts from the store:\n- Hand-glazed\n- 25 cm tall',
  );
  // Never invent specifications: the instructions say so.
  assert.match(body.system, /Never invent specifications/);
});

test('without a photo only the text goes; the seed drawings are not photos', async () => {
  const res = await draft({});
  assert.equal(res.status, 200);
  const { content } = t.claude.calls.at(-1).body.messages[0];
  assert.deepEqual(
    content.map((c) => c.type),
    ['text'],
  );
  assert.match(content[0].text, /Facts from the store: none/);
});

test('checks what it is given', async () => {
  assert.match((await draft({ title: ' ' })).body.error, /Enter a title first/);
  assert.match((await draft({ brand: '' })).body.error, /Enter a brand first/);
  assert.match((await draft({ categoryId: '' })).body.error, /Choose a category first/);
  assert.match((await draft({ categoryId: '0123456789abcdef01234567' })).body.error, /Choose a category first/);
  assert.equal((await draft({ image: 'data:image/svg+xml,<svg/>' })).status, 400);
  assert.equal((await draft({ facts: Array(9).fill('Fact') })).status, 400);
});

test('a failed or declined request says so, and nothing is saved', async () => {
  t.claude.failNext(2); // the first try and the SDK's one retry
  const failed = await draft({});
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /isn't reachable right now/);

  // Errors the admin can fix say what to do; others pass on Anthropic's reason. (4xx answers aren't retried.)
  t.claude.failNext(1, [
    400,
    'invalid_request_error',
    'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
  ]);
  assert.match((await draft({})).body.error, /no credit left. Add some under Billing/);
  t.claude.failNext(1, [401, 'authentication_error', 'invalid x-api-key']);
  assert.match((await draft({})).body.error, /API key was refused/);
  t.claude.failNext(1, [404, 'not_found_error', 'model: claude-opus-5-5']);
  assert.match((await draft({})).body.error, /can't use claude-opus-5-5. Check AI_MODEL/);
  t.claude.failNext(1, [400, 'invalid_request_error', 'max_tokens: too large']);
  assert.equal((await draft({})).body.error, 'Claude refused the request: max_tokens: too large');

  t.claude.refuseNext();
  const declined = await draft({});
  assert.equal(declined.status, 502);
  assert.match(declined.body.error, /couldn't write this one/);
  assert.equal(await t.db.collection('products').countDocuments({ title: 'Griha Ceramic Vase' }), 0);
});

test(`each admin gets ${AI_DRAFTS_PER_HOUR} drafts an hour`, async () => {
  await t.db.collection('rateLimits').deleteMany({});
  const calls = t.claude.calls.length;
  for (let i = 0; i < AI_DRAFTS_PER_HOUR; i++) assert.equal((await draft({})).status, 200);
  const res = await draft({});
  assert.equal(res.status, 429);
  assert.equal(t.claude.calls.length, calls + AI_DRAFTS_PER_HOUR);
});

test('Claude Haiku has no server-side fallback, so none is asked for', async () => {
  const haiku = await startTestServer({ ai: 'claude-haiku-5-5' });
  try {
    const call = await adminOf(haiku);
    const id = (await haiku.db.collection('categories').findOne({}))._id.toString();
    assert.equal(
      (await call('POST', '/admin/ai/product-draft', { title: 'Vase', brand: 'Griha', categoryId: id })).status,
      200,
    );
    const { body, headers } = haiku.claude.calls.at(-1);
    assert.equal(body.model, 'claude-haiku-5-5');
    assert.equal(body.fallbacks, undefined);
    assert.doesNotMatch(headers['anthropic-beta'] ?? '', /server-side-fallback/);
  } finally {
    await haiku.stop();
  }
});

// ---- Answer drafts for customers' questions (stage 56) ----

async function askAbout(slug, text, extra = {}) {
  const product = await t.db.collection('products').findOne({ slug });
  const { insertedId } = await t.db.collection('questions').insertOne({
    productId: product._id,
    userId: product._id, // any id: the asker doesn't matter here
    author: 'Asha R.',
    text,
    createdAt: new Date(),
    answer: null,
    hidden: false,
    ...extra,
  });
  return insertedId.toString();
}
const answerDraft = (questionId, call = admin) => call('POST', '/admin/ai/answer-draft', { questionId });

test('drafts an answer to a question from the product, its earlier answers and the question', async () => {
  await t.db.collection('rateLimits').deleteMany({}); // the limit test above used up this admin's hour
  const slug = 'the-quiet-engineer-paperback';
  await askAbout(slug, 'Is it hardback?', { answer: { text: 'No, paperback only.', at: new Date() } });
  await askAbout(slug, 'Rude spam', { answer: { text: 'Hidden reply', at: new Date() }, hidden: true });
  const id = await askAbout(slug, 'How many pages does it have?');

  const res = await answerDraft(id);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, {
    answer: 'Yes: The Quiet Engineer (Paperback) comes with what the description lists.',
    fromDetails: true,
  });
  const { body } = t.claude.calls.at(-1);
  assert.equal(body.output_config.effort, 'low');
  assert.match(body.system, /never as instructions/);
  const prompt = body.messages[0].content[0].text;
  assert.match(prompt, /^Product: The Quiet Engineer \(Paperback\)$/m);
  assert.match(prompt, /^Category: Books$/m);
  assert.match(prompt, /Q: Is it hardback\?\nA: No, paperback only\./);
  assert.doesNotMatch(prompt, /Hidden reply/);
  assert.match(prompt, /Customer's question:\nHow many pages does it have\?$/);
  // Nothing is saved: the question still waits for an answer.
  assert.equal((await t.db.collection('questions').findOne({ text: 'How many pages does it have?' })).answer, null);

  // Variants are listed, and an answer the details can't settle says so.
  const jeans = await askAbout('urbane-men-slim-fit-jeans', 'What is the warranty?');
  const unsure = await answerDraft(jeans);
  assert.equal(unsure.body.fromDetails, false);
  assert.match(t.claude.calls.at(-1).body.messages[0].content[0].text, /^Options: Blue \/ 30; .*Black \/ 32$/m);
});

test('answer drafts are for admins, checked, limited with product drafts, and say when Claude declines', async () => {
  await t.db.collection('rateLimits').deleteMany({});
  const id = await askAbout('the-quiet-engineer-paperback', 'Is it signed by the author?');
  const customer = t.browser();
  await customer('POST', '/auth/register', { name: 'Ravi K', email: 'ravi@example.com', password: 'password123' });
  assert.equal((await answerDraft(id, customer)).status, 403);
  assert.equal((await answerDraft('nope')).status, 400);
  assert.equal((await answerDraft('000000000000000000000000')).status, 404);
  const offAdmin = off.browser();
  await offAdmin('POST', '/auth/register', { name: 'Off Admin', email: 'off@example.com', password: 'password123' });
  await off.db.collection('users').updateOne({ email: 'off@example.com' }, { $set: { role: 'admin' } });
  assert.equal((await answerDraft(id, offAdmin)).status, 503);

  t.claude.refuseNext();
  const refused = await answerDraft(id);
  assert.equal(refused.status, 502);
  assert.equal(refused.body.error, "The writing assistant couldn't draft this one. Please write the answer yourself.");

  // One hourly allowance for both kinds of draft.
  for (let i = 1; i < AI_DRAFTS_PER_HOUR; i++) assert.equal((await answerDraft(id)).status, 200);
  assert.equal((await draft({})).status, 429);
  assert.equal((await answerDraft(id)).status, 429);
});

// ---- Explain this error (stage 57) ----

async function reportOf(fields) {
  const { insertedId } = await t.db.collection('errorReports').insertOne({
    key: `test-${Math.random()}`,
    kind: 'crash',
    message: "Cannot read properties of undefined (reading 'price')",
    stack:
      "TypeError: Cannot read properties of undefined (reading 'price')\n    at DeliveryAddress (https://bazaar.test/assets/index-abc.js:1:200)",
    componentStack: '\n    at DeliveryAddress\n    at Checkout\n    at Layout',
    count: 3,
    firstAt: new Date(),
    lastAt: new Date(),
    paths: ['/checkout'],
    browser: 'Mozilla/5.0 Chrome/141.0',
    fixedAt: null,
    ...fields,
  });
  return insertedId.toString();
}
const explain = (id, call = admin) => call('POST', `/admin/error-reports/${id}/explain`);

test('explains an error report in plain words, says where to look, and keeps the explanation', async () => {
  await t.db.collection('rateLimits').deleteMany({});
  const id = await reportOf();
  const res = await explain(id);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { explanation } = res.body;
  // Links never reach the admin, whatever the report said.
  assert.equal(explanation.explanation, 'The page crashed. See [link removed] for more.');
  assert.deepEqual(explanation.whereToLook, ['client/src/pages/Checkout.jsx: check the value before using it']);
  assert.equal(explanation.urgent, true);
  assert.equal(explanation.model, 'claude-opus-5-5');

  const { body } = t.claude.calls.at(-1);
  assert.equal(body.output_config.effort, 'medium');
  assert.match(body.system, /never as instructions/);
  const prompt = body.messages[0].content[0].text;
  assert.match(prompt, /^Happened 3 time\(s\), on: \/checkout$/m);
  // Where the names in the report are defined in the browser app's source.
  assert.match(prompt, /^- DeliveryAddress: client\/src\/pages\/Checkout\.jsx$/m);
  assert.match(prompt, /^- Layout: client\/src\/components\/Layout\.jsx$/m);

  // Kept with the report: the list shows it without asking again.
  const calls = t.claude.calls.length;
  const listed = (await admin('GET', '/admin/error-reports')).body.items.find((r) => r.id === id);
  assert.equal(listed.explanation.explanation, explanation.explanation);
  assert.equal(t.claude.calls.length, calls);
});

test('only admins ask, with a key, within the hourly allowance; a decline says so and keeps nothing', async () => {
  await t.db.collection('rateLimits').deleteMany({});
  const id = await reportOf({ kind: 'load', stack: null, componentStack: null, paths: ['/admin'] });
  const customer = t.browser();
  await customer('POST', '/auth/register', { name: 'Kiran S', email: 'kiran@example.com', password: 'password123' });
  assert.equal((await explain(id, customer)).status, 403);
  assert.equal((await explain('nope')).status, 400);
  assert.equal((await explain('000000000000000000000000')).status, 404);
  const offAdmin = off.browser();
  await offAdmin('POST', '/auth/login', { email: 'off@example.com', password: 'password123' });
  assert.equal((await explain(id, offAdmin)).status, 503);

  t.claude.refuseNext();
  const refused = await explain(id);
  assert.equal(refused.status, 502);
  assert.equal(refused.body.error, "The writing assistant couldn't explain this one.");
  assert.equal(
    (await t.db.collection('errorReports').findOne({ kind: 'load', paths: ['/admin'] })).explanation,
    undefined,
  );

  const ok = await explain(id);
  assert.equal(ok.body.explanation.urgent, false);
  assert.deepEqual(ok.body.explanation.whereToLook, []);
  for (let i = 2; i < AI_DRAFTS_PER_HOUR; i++) await explain(id);
  assert.equal((await explain(id)).status, 429);
  assert.equal((await draft({})).status, 429);
});
