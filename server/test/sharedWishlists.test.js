import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let asha;
before(async () => {
  t = await startTestServer();
  asha = t.browser();
  await asha('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
});
after(() => t.stop());

const id = async (slug) => (await t.db.collection('products').findOne({ slug }))._id.toString();

test('a customer shares their wishlist by a link, which shows their first name and shown products only', async () => {
  assert.equal((await t.call('POST', '/wishlist/share')).status, 401);
  assert.deepEqual((await asha('GET', '/wishlist/share')).body, { share: null });
  await asha('PUT', `/wishlist/${await id('the-quiet-engineer-paperback')}`);
  await asha('PUT', `/wishlist/${await id('orbit-a14-4gb-ram-64gb')}`);

  const { share } = (await asha('POST', '/wishlist/share')).body;
  assert.match(share.token, /^[\w-]{24}$/);
  assert.deepEqual((await asha('POST', '/wishlist/share')).body.share, share); // the same link again

  const shared = await t.call('GET', `/shared-wishlists/${share.token}`);
  assert.equal(shared.status, 200);
  assert.equal(shared.body.name, 'Asha');
  assert.deepEqual(
    shared.body.items.map((p) => p.slug),
    ['orbit-a14-4gb-ram-64gb', 'the-quiet-engineer-paperback'],
  );
  assert.equal(JSON.stringify(shared.body).includes('asha@example.com'), false);

  // A hidden product drops out of the shared list too.
  await t.db.collection('products').updateOne({ slug: 'orbit-a14-4gb-ram-64gb' }, { $set: { active: false } });
  assert.equal((await t.call('GET', `/shared-wishlists/${share.token}`)).body.items.length, 1);
  await t.db.collection('products').updateOne({ slug: 'orbit-a14-4gb-ram-64gb' }, { $set: { active: true } });

  // The data download says it's shared.
  assert.equal((await asha('GET', '/account/data')).body.wishlistShared, true);
});

test('stopping kills the link; sharing again makes a new one; made-up links find nothing', async () => {
  const { share: old } = (await asha('GET', '/wishlist/share')).body;
  assert.deepEqual((await asha('DELETE', '/wishlist/share')).body, { share: null });
  assert.equal((await t.call('GET', `/shared-wishlists/${old.token}`)).status, 404);
  const { share } = (await asha('POST', '/wishlist/share')).body;
  assert.notEqual(share.token, old.token);
  assert.equal((await t.call('GET', `/shared-wishlists/${share.token}`)).status, 200);
  assert.equal((await t.call('GET', '/shared-wishlists/abc')).status, 404);
  assert.equal((await t.call('GET', `/shared-wishlists/${'x'.repeat(24)}`)).status, 404);
  // The robots file keeps shared lists out of search engines.
  assert.ok((await import('../src/preview.js')).PRIVATE_PATHS.includes('/w/'));
});
