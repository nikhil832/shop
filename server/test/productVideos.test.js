import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { youtubeId } from '../src/videos.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
let book;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  customer = await register('customer@example.com', 'Asha Rao');
  book = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}

test('YouTube links of every common shape give the video id; other links give nothing', () => {
  for (const link of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123',
    'youtube.com/watch?v=dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=abc',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
  ]) {
    assert.equal(youtubeId(link), 'dQw4w9WgXcQ', link);
  }
  for (const link of [
    'https://vimeo.com/123456789',
    'https://www.youtube.com/channel/UC1234567890',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://evil.example/?u=youtu.be/dQw4w9WgXcQ',
    'javascript:alert(1)',
    'not a link',
  ]) {
    assert.equal(youtubeId(link), null, link);
  }
});

test('an admin adds a video by its link; the store gets only the id, and removing it clears it', async () => {
  let res = await admin('PATCH', `/admin/products/${book._id}`, { video: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(res.status, 200);
  assert.equal(res.body.video, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.deepEqual((await t.db.collection('products').findOne({ _id: book._id })).video, { youtubeId: 'dQw4w9WgXcQ' });
  assert.deepEqual((await t.call('GET', `/products/${book.slug}`)).body.video, { youtubeId: 'dQw4w9WgXcQ' });

  const entry = await t.db.collection('activity').findOne({ 'changes.field': 'Video' });
  assert.deepEqual(
    entry.changes.find((c) => c.field === 'Video'),
    { field: 'Video', from: 'none', to: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  );
  // Other saves keep it; a copy has it too.
  assert.equal((await admin('PATCH', `/admin/products/${book._id}`, { stock: 90 })).body.video, res.body.video);
  assert.equal((await admin('POST', `/admin/products/${book._id}/duplicate`)).body.video, res.body.video);

  res = await admin('PATCH', `/admin/products/${book._id}`, { video: '' });
  assert.equal(res.body.video, null);
  assert.equal((await t.call('GET', `/products/${book.slug}`)).body.video, null);
});

test('links that are not YouTube videos are refused, and only admins can set one', async () => {
  const res = await admin('PATCH', `/admin/products/${book._id}`, { video: 'https://vimeo.com/123456789' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /^video: Paste a link to a YouTube video/);
  assert.equal(
    (await customer('PATCH', `/admin/products/${book._id}`, { video: 'https://youtu.be/dQw4w9WgXcQ' })).status,
    403,
  );
  assert.equal((await t.db.collection('products').findOne({ _id: book._id })).video, null);
  // Products without one say so.
  assert.equal((await t.call('GET', '/products/stride-running-shoes')).body.video, null);
});
