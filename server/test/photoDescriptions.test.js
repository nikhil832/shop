import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// Descriptions of product photos for screen readers (stage 59). Claude is a stand-in (t.claude): nothing here calls
// the real API or costs money.
let t;
let off; // a server without an API key
let admin;
let categoryId;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

before(async () => {
  [t, off] = await Promise.all([startTestServer({ ai: 'claude-opus-5-5' }), startTestServer()]);
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  categoryId = (await t.db.collection('categories').findOne({ name: 'Home & Kitchen' }))._id.toString();
});
after(() => Promise.all([t.stop(), off.stop()]));

const uploadPhoto = async () => (await admin('POST', '/admin/images', PNG, 'image/png')).body.url;
const newProduct = (body) =>
  admin('POST', '/admin/products', {
    title: 'Griha Ceramic Vase',
    brand: 'Griha',
    categoryId,
    price: 49900,
    mrp: 59900,
    stock: 5,
    ...body,
  });

test('photo descriptions are saved with the product and shown in the store, for its uploaded photos only', async () => {
  const [front, side] = [await uploadPhoto(), await uploadPhoto()];
  const res = await newProduct({
    images: [front, side],
    imageAlts: { [front]: '  Blue vase from the front  ', [side]: '', '/api/images/0123456789abcdef01234567': 'gone' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  // Empty descriptions and photos the product doesn't have are dropped.
  assert.deepEqual(res.body.imageAlts, { [front]: 'Blue vase from the front' });
  const stored = await t.db.collection('products').findOne({ slug: res.body.slug });
  assert.deepEqual(stored.imageAlts, { [front.split('/').pop()]: 'Blue vase from the front' });
  assert.deepEqual((await t.call('GET', `/products/${res.body.slug}`)).body.imageAlts, {
    [front]: 'Blue vase from the front',
  });
  // Products without any (the sample catalog) give an empty map.
  assert.deepEqual((await t.call('GET', '/products/the-quiet-engineer-paperback')).body.imageAlts, {});

  for (const [imageAlts, error] of [
    [{ [front]: 'x'.repeat(151) }, /at most 150 characters/],
    [{ 'data:image/svg+xml,<svg/>': 'A drawing' }, /imageAlts\.data:image.*Invalid key/],
  ]) {
    const bad = await newProduct({ images: [front], imageAlts });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, error);
  }
});

test('editing: descriptions change with the product (logged), and go with removed photos', async () => {
  const [front, side] = [await uploadPhoto(), await uploadPhoto()];
  const { id } = (await newProduct({ title: 'Griha Tall Vase', images: [front, side] })).body;
  const edited = await admin('PATCH', `/admin/products/${id}`, {
    imageAlts: { [front]: 'Tall vase, front', [side]: 'Tall vase, side' },
  });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.body.imageAlts, { [front]: 'Tall vase, front', [side]: 'Tall vase, side' });
  const entry = (await admin('GET', '/admin/activity?area=products')).body.items[0];
  assert.deepEqual(entry.changes, [{ field: 'Photo descriptions', to: 'edited' }]);

  // Reordering keeps them; removing a photo drops its description, even when no descriptions are sent.
  const reordered = await admin('PATCH', `/admin/products/${id}`, { images: [side, front] });
  assert.deepEqual(reordered.body.imageAlts, { [side]: 'Tall vase, side', [front]: 'Tall vase, front' });
  const removed = await admin('PATCH', `/admin/products/${id}`, { images: [front] });
  assert.deepEqual(removed.body.imageAlts, { [front]: 'Tall vase, front' });
});

test('Claude suggests a description of an uploaded photo, for the admin to check', async () => {
  const photo = await uploadPhoto();
  const res = await admin('POST', '/admin/ai/alt-text', { image: photo, title: 'Griha Ceramic Vase' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // "Photo of" is taken off the front.
  assert.deepEqual(res.body, { alt: 'a blue vase, seen from the side' });
  const { body } = t.claude.calls.at(-1);
  const [image, text] = body.messages[0].content;
  assert.deepEqual(image.source, { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') });
  assert.equal(text.text, 'Product title: Griha Ceramic Vase');
  assert.match(body.system, /at most 125 characters/);
  // Nothing is saved.
  assert.equal(await t.db.collection('products').countDocuments({ 'imageAlts.x': { $exists: true } }), 0);

  assert.equal((await admin('POST', '/admin/ai/alt-text', { image: 'data:image/svg+xml,<svg/>' })).status, 400);
  const gone = await admin('POST', '/admin/ai/alt-text', { image: '/api/images/0123456789abcdef01234567' });
  assert.equal(gone.status, 404);
  t.claude.refuseNext();
  const refused = await admin('POST', '/admin/ai/alt-text', { image: photo });
  assert.equal(refused.status, 502);
  assert.equal(refused.body.error, "The writing assistant couldn't describe this photo. Please write it yourself.");
});

test('suggestions are for admins, need the API key, and share the hourly allowance', async () => {
  const customer = t.browser();
  await customer('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
  assert.equal((await customer('POST', '/admin/ai/alt-text', {})).status, 403);
  const offAdmin = off.browser();
  await offAdmin('POST', '/auth/register', { name: 'Off Admin', email: 'off@example.com', password: 'password123' });
  await off.db.collection('users').updateOne({ email: 'off@example.com' }, { $set: { role: 'admin' } });
  const offPhoto = (await offAdmin('POST', '/admin/images', PNG, 'image/png')).body.url;
  assert.equal((await offAdmin('POST', '/admin/ai/alt-text', { image: offPhoto })).status, 503);

  await t.db.collection('rateLimits').deleteMany({});
  const photo = await uploadPhoto();
  for (let i = 0; i < 30; i++) assert.equal((await admin('POST', '/admin/ai/alt-text', { image: photo })).status, 200);
  assert.equal((await admin('POST', '/admin/ai/alt-text', { image: photo })).status, 429);
});
