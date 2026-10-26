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
