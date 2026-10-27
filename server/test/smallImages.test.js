import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { deleteUnusedImages, UNUSED_IMAGE_GRACE_MS } from '../src/routes/images.js';
import { startTestServer } from './helpers.js';

// Small versions of product photos (stage 68): made in the admin's browser and stored next to the photo.
let t;
let admin;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
// A different (still valid) PNG for the small one, so the two can be told apart.
const SMALL = Buffer.concat([PNG, Buffer.from('small')]);

before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
});
after(() => t.stop());

const upload = async () => (await admin('POST', '/admin/images', PNG, 'image/png')).body;
const get = (url) => fetch(t.base.replace(/\/api$/, '') + url);

test('a photo gets a small version, served with ?size=small; without one, the photo itself', async () => {
  const photo = await upload();
  const plain = await get(`${photo.url}?size=small`);
  assert.equal(plain.headers.get('cache-control'), 'public, max-age=86400');
  assert.deepEqual(Buffer.from(await plain.arrayBuffer()), PNG);

  const res = await admin('POST', `/admin/images/${photo.id}/small`, SMALL, 'image/png');
  assert.equal(res.status, 201);
  assert.equal(res.body.url, `${photo.url}?size=small`);
  const small = await get(`${photo.url}?size=small`);
  assert.equal(small.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.deepEqual(Buffer.from(await small.arrayBuffer()), SMALL);
  assert.deepEqual(Buffer.from(await (await get(photo.url)).arrayBuffer()), PNG); // the photo itself is unchanged

  // A new small version replaces the old one.
  const first = (await t.db.collection('images').findOne({ _id: new ObjectId(photo.id) })).smallId;
  await admin('POST', `/admin/images/${photo.id}/small`, SMALL, 'image/png');
  assert.equal(await t.db.collection('images').countDocuments({ _id: first }), 0);
  assert.equal(await t.db.collection('images').countDocuments({ kind: 'small', of: new ObjectId(photo.id) }), 1);
});

test('small versions are checked and only for admins', async () => {
  const photo = await upload();
  assert.equal((await admin('POST', `/admin/images/${photo.id}/small`, Buffer.from('nope'), 'image/png')).status, 400);
  const big = Buffer.concat([PNG, Buffer.alloc(201 * 1024)]);
  assert.equal((await admin('POST', `/admin/images/${photo.id}/small`, big, 'image/png')).status, 413);
  assert.equal((await admin('POST', '/admin/images/000000000000000000000000/small', SMALL, 'image/png')).status, 404);
  const customer = t.browser();
  await customer('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
  assert.equal((await customer('POST', `/admin/images/${photo.id}/small`, SMALL, 'image/png')).status, 403);
  assert.equal((await customer('GET', '/admin/images/without-small')).status, 403);
  // A small version can't have its own.
  await admin('POST', `/admin/images/${photo.id}/small`, SMALL, 'image/png');
  const smallId = (await t.db.collection('images').findOne({ _id: new ObjectId(photo.id) })).smallId;
  assert.equal((await admin('POST', `/admin/images/${smallId}/small`, SMALL, 'image/png')).status, 404);
});

test('older product photos without one are listed; the clean-up keeps a small version while its photo is used', async () => {
  const [withSmall, without] = [await upload(), await upload()];
  await admin('POST', `/admin/images/${withSmall.id}/small`, SMALL, 'image/png');
  const category = await t.db.collection('categories').findOne({ slug: 'home-kitchen' });
  const product = await admin('POST', '/admin/products', {
    title: 'Griha Vase',
    brand: 'Griha',
    categoryId: category._id.toString(),
    price: 49900,
    mrp: 59900,
    stock: 3,
    images: [withSmall.url, without.url],
  });
  assert.equal(product.status, 201);
  const listed = (await admin('GET', '/admin/images/without-small')).body.urls;
  assert.ok(listed.includes(without.url));
  assert.ok(!listed.includes(withSmall.url));

  const later = new Date(Date.now() + UNUSED_IMAGE_GRACE_MS + 60_000);
  await deleteUnusedImages(t.ctx, { now: later });
  const images = t.db.collection('images');
  assert.equal(await images.countDocuments({ kind: 'small', of: new ObjectId(withSmall.id) }), 1);

  // Once the product drops the photo, the photo and its small version both go.
  await admin('PATCH', `/admin/products/${product.body.id}`, { images: [without.url] });
  await deleteUnusedImages(t.ctx, { now: later });
  assert.equal(await images.countDocuments({ _id: new ObjectId(withSmall.id) }), 0);
  assert.equal(await images.countDocuments({ kind: 'small', of: new ObjectId(withSmall.id) }), 0);
});
