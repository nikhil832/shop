import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { startTestServer } from './helpers.js';
import { stripMetadata } from '../src/imageMetadata.js';
import { deleteUnusedImages } from '../src/routes/images.js';

// A JPEG made of segments: [marker, payload] pairs, then image data. Enough for the checks here (not a real picture).
const segment = (marker, payload) => {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, Buffer.from(payload)]);
};
const IMAGE_DATA = Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x10, 0x20, 0x30, 0xff, 0xd9]);
const jpeg = (...segments) => Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, IMAGE_DATA]);
const GPS = 'Exif\0\0GPS 12.9716N 77.5946E';
const PHOTO = jpeg(
  segment(0xe0, 'JFIF\0'),
  segment(0xe1, GPS),
  segment(0xe2, 'ICC_PROFILE\0'),
  segment(0xfe, 'taken at home'),
  segment(0xdb, 'quant'),
);

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), Buffer.from(data), Buffer.alloc(4)]);
};
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', 'header'),
  chunk('tEXt', 'Location\0Bengaluru'),
  chunk('eXIf', GPS),
  chunk('IDAT', 'pixels'),
  chunk('IEND', ''),
]);

test('location and other metadata are removed; the picture and colour information stay', () => {
  const clean = stripMetadata('image/jpeg', PHOTO);
  assert.ok(!clean.toString('latin1').includes('GPS'));
  assert.ok(!clean.toString('latin1').includes('taken at home'));
  assert.ok(clean.toString('latin1').includes('JFIF'));
  assert.ok(clean.toString('latin1').includes('ICC_PROFILE'));
  assert.ok(clean.subarray(-IMAGE_DATA.length).equals(IMAGE_DATA));

  const png = stripMetadata('image/png', PNG).toString('latin1');
  assert.ok(!png.includes('Bengaluru') && !png.includes('GPS'));
  assert.ok(png.includes('IHDR') && png.includes('IDAT') && png.includes('IEND'));

  assert.throws(() => stripMetadata('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff])));
  assert.throws(() => stripMetadata('image/png', PNG.subarray(0, 30)));
});

let t;
let admin;
let buyer;
let other;
const BOOK = 'the-quiet-engineer-paperback';
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'Store Admin');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  buyer = await register('asha@example.com', 'Asha Rao');
  other = await register('ravi@example.com', 'Ravi Kumar');
  // Asha's order of the book, delivered, so she may review it.
  const p = await t.db.collection('products').findOne({ slug: BOOK });
  const quote = await buyer('GET', `/cart?items=${p._id}:1`);
  const order = await buyer('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty: 1 }],
    address: {
      name: 'Asha Rao',
      phone: '9876543210',
      line1: '12 MG Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
    },
    expectedTotal: quote.body.total,
  });
  await admin('POST', `/admin/orders/${order.body.id}/status`, { status: 'shipped' });
  await admin('POST', `/admin/orders/${order.body.id}/status`, { status: 'delivered' });
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}
const upload = (who, body = PHOTO, type = 'image/jpeg') => who('POST', '/reviews/photos', body, type);
const review = (photos) => buyer('PUT', `/products/${BOOK}/review`, { rating: 5, title: 'Lovely', photos });

test('customers upload review photos, stored without their location', async () => {
  assert.equal((await upload(t.call)).status, 401);
  const res = await upload(buyer);
  assert.equal(res.status, 201);
  assert.match(res.body.url, /^\/api\/images\/[0-9a-f]{24}$/);
  const served = await t.call('GET', res.body.url.slice(4));
  assert.equal(served.status, 200);
  assert.ok(!served.body.toString('latin1').includes('GPS'));

  assert.equal((await upload(buyer, PNG, 'image/png')).status, 201);
  assert.match((await upload(buyer, Buffer.from('RIFF0000WEBPVP8 '), 'image/webp')).body.error, /JPEG or PNG/);
  assert.match((await upload(buyer, Buffer.from('not a photo'), 'image/jpeg')).body.error, /not a valid JPEG/);
  assert.match(
    (await upload(buyer, Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x99]), 'image/jpeg')).body.error,
    /not a valid JPEG/,
  );
});

test('a review shows up to 3 of its writer’s own photos', async () => {
  const urls = [];
  for (let i = 0; i < 4; i++) urls.push((await upload(buyer)).body.url);
  const res = await review(urls.slice(0, 3));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.photos, urls.slice(0, 3));
  const listed = (await t.call('GET', `/products/${BOOK}/reviews`)).body.items[0];
  assert.deepEqual(listed.photos, urls.slice(0, 3));
  assert.deepEqual((await admin('GET', '/admin/reviews')).body.items[0].photos, urls.slice(0, 3));

  assert.match((await review(urls)).body.error, /At most 3 photos/);
  assert.match((await review([urls[0], urls[0]])).body.error, /same photo twice/);
  const ravis = (await upload(other)).body.url;
  assert.match((await review([ravis])).body.error, /Upload the photos again/);
  const adminPhoto = (await admin('POST', '/admin/images', PHOTO, 'image/jpeg')).body.url;
  assert.match((await review([adminPhoto])).body.error, /Upload the photos again/);
  assert.match((await review(['/api/images/nope'])).body.error, /Invalid photo/);

  // Editing without photos removes them.
  assert.deepEqual((await review([])).body.photos, []);
  await review(urls.slice(0, 2));
});

test('photos in reviews are kept by the cleanup; unused uploads go after a day', async () => {
  const kept = (await t.call('GET', `/products/${BOOK}/reviews`)).body.items[0].photos;
  const unused = (await upload(buyer)).body.url;
  const later = new Date(Date.now() + 2 * 86_400_000);
  await deleteUnusedImages(t.ctx, { now: later });
  const exists = async (url) =>
    Boolean(await t.db.collection('images').findOne({ _id: new ObjectId(url.slice(-24)) }, { projection: { _id: 1 } }));
  assert.equal(await exists(kept[0]), true);
  assert.equal(await exists(kept[1]), true);
  assert.equal(await exists(unused), false);
});

test('at most 20 photos an hour per customer', async () => {
  const fresh = await register('meera@example.com', 'Meera Iyer');
  for (let i = 0; i < 20; i++) assert.equal((await upload(fresh)).status, 201);
  const res = await upload(fresh);
  assert.equal(res.status, 429);
  assert.match(res.body.error, /Too many photos/);
});
