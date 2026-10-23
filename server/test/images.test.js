import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { deleteUnusedImages, UNUSED_IMAGE_GRACE_MS } from '../src/routes/images.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'Store Admin');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  customer = await register('customer@example.com', 'Asha Rao');
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name, email, password: 'password123' });
  assert.equal(res.status, 201);
  return call;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const DAY = 24 * 60 * 60 * 1000;
const images = () => t.db.collection('images');
// Whether the photo is still served (the test client adds /api itself).
const exists = async (url) => (await t.call('GET', url.replace(/^\/api/, ''))).status === 200;

async function upload() {
  const res = await admin('POST', '/admin/images', PNG, 'image/png');
  assert.equal(res.status, 201);
  return res.body.url;
}
// Makes an upload look older, as if it had been sitting there for `ms`.
const age = (url, ms) =>
  images().updateOne({ _id: new ObjectId(url.split('/').at(-1)) }, { $set: { createdAt: new Date(Date.now() - ms) } });
const categoryId = async () => (await t.db.collection('categories').findOne({ slug: 'books' }))._id.toString();

async function createProduct(title, photos) {
  const res = await admin('POST', '/admin/products', {
    title,
    brand: 'Inkwell',
    categoryId: await categoryId(),
    price: 49900,
    mrp: 59900,
    stock: 20,
    images: photos,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('deletes uploads a day old that no product or order uses, and keeps the rest', async () => {
  const unused = await upload();
  const recent = await upload(); // still within the grace period: the admin may be filling in the form
  const onProduct = await upload();
  const onHidden = await upload();
  await createProduct('Kept Photo Notebook', [onProduct]);
  const hidden = await createProduct('Hidden Photo Notebook', [onHidden]);
  assert.equal((await admin('PATCH', `/admin/products/${hidden.id}`, { active: false })).status, 200);
  for (const url of [unused, onProduct, onHidden]) await age(url, DAY + 60_000);
  await age(recent, DAY - 60 * 60_000);

  const result = await deleteUnusedImages(t.ctx);
  assert.deepEqual(result, { deleted: 1, bytes: PNG.length });
  assert.equal(await exists(unused), false);
  for (const url of [recent, onProduct, onHidden]) assert.equal(await exists(url), true, url);

  // The sample catalog's inline SVG images are not uploads and are never touched.
  assert.equal(await t.db.collection('products').countDocuments({ images: /^data:image\/svg/ }), 38);
  // Nothing more to do on the next run.
  assert.deepEqual(await deleteUnusedImages(t.ctx), { deleted: 0, bytes: 0 });
});

test('a photo replaced on its product is deleted, unless an order was placed with it', async () => {
  const sold = await upload();
  const notSold = await upload();
  const soldProduct = await createProduct('Sold Photo Journal', [sold]);
  const otherProduct = await createProduct('Unsold Photo Journal', [notSold]);

  const quote = await customer('GET', `/cart?items=${soldProduct.id}:1`);
  const order = await customer('POST', '/orders', {
    items: [{ productId: soldProduct.id, qty: 1 }],
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
  assert.equal(order.status, 201);
  assert.equal(order.body.items[0].image, sold);

  // Both products get a new photo.
  for (const product of [soldProduct, otherProduct]) {
    const replacement = await upload();
    assert.equal((await admin('PATCH', `/admin/products/${product.id}`, { images: [replacement] })).status, 200);
  }
  for (const url of [sold, notSold]) await age(url, 2 * DAY);

  const result = await deleteUnusedImages(t.ctx);
  assert.equal(result.deleted, 1);
  assert.equal(await exists(notSold), false);
  // The order still shows the photo it was bought with.
  assert.equal(await exists(sold), true);
});

test('saving a product with a photo deleted as unused asks for it to be uploaded again', async () => {
  const gone = await upload();
  const kept = await upload();
  await age(gone, UNUSED_IMAGE_GRACE_MS + 60_000);
  await deleteUnusedImages(t.ctx);
  assert.equal(await exists(gone), false);

  const body = {
    title: 'Late Photo Diary',
    brand: 'Inkwell',
    categoryId: await categoryId(),
    price: 49900,
    mrp: 59900,
    stock: 20,
    images: [kept, gone],
  };
  const created = await admin('POST', '/admin/products', body);
  assert.equal(created.status, 400);
  assert.match(created.body.error, /^images: A photo was removed because it went unused for a day\. Upload it again\./);

  const product = await createProduct('Late Photo Diary', [kept]);
  const edited = await admin('PATCH', `/admin/products/${product.id}`, { images: [kept, gone] });
  assert.equal(edited.status, 400);
  assert.match(edited.body.error, /Upload it again/);
  // Edits without photos are not affected.
  assert.equal((await admin('PATCH', `/admin/products/${product.id}`, { stock: 5 })).status, 200);
});
