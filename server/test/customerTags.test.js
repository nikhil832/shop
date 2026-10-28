import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { MAX_NOTES } from '../src/customerTags.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let support;
let asha;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  support = await register('support@example.com', 'Sam Support');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  await t.db.collection('users').updateOne({ email: 'support@example.com' }, { $set: { role: 'support' } });
  asha = await register('asha@example.com', 'Asha Rao');
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  call.id = (await call('GET', '/auth/me')).body.user.id;
  return call;
}

const address = {
  name: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};

test('admins tag customers and filter the list by tag; changes are logged', async () => {
  const res = await admin('PUT', `/admin/customers/${asha.id}/tags`, { tags: ['vip', 'wholesale', 'vip'] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.tags, ['vip', 'wholesale']);
  const vips = (await admin('GET', '/admin/customers?tag=vip')).body.items;
  assert.deepEqual(
    vips.map((c) => [c.email, c.tags]),
    [['asha@example.com', ['vip', 'wholesale']]],
  );
  assert.equal((await admin('GET', '/admin/customers?tag=watch')).body.total, 0);
  const log = await t.db.collection('activity').findOne({ action: 'Changed customer tags' });
  assert.deepEqual(log.changes[0], { field: 'Tags', from: '(none)', to: 'VIP, Wholesale' });
  assert.equal((await admin('PUT', `/admin/customers/${asha.id}/tags`, { tags: ['nice'] })).status, 400);
  assert.equal((await admin('GET', '/admin/customers?tag=nice')).status, 400);
});

test('notes are dated and signed, newest first, removable, and at most 50', async () => {
  const first = await admin('POST', `/admin/customers/${asha.id}/notes`, { text: 'Prefers deliveries after 6 pm' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  await admin('POST', `/admin/customers/${asha.id}/notes`, { text: 'Runs a small shop; buys in bulk at Diwali' });
  const page = (await admin('GET', `/admin/customers/${asha.id}`)).body;
  assert.deepEqual(
    page.customer.notes.map((n) => [n.text, n.by]),
    [
      ['Runs a small shop; buys in bulk at Diwali', 'Store Owner'],
      ['Prefers deliveries after 6 pm', 'Store Owner'],
    ],
  );
  assert.equal((await admin('DELETE', `/admin/customers/${asha.id}/notes/${first.body.id}`)).status, 204);
  assert.equal((await admin('DELETE', `/admin/customers/${asha.id}/notes/${first.body.id}`)).status, 404);
  assert.equal((await admin('POST', `/admin/customers/${asha.id}/notes`, { text: ' ' })).status, 400);

  await t.db.collection('users').updateOne(
    { email: 'asha@example.com' },
    {
      $push: {
        adminNotes: {
          $each: Array.from({ length: MAX_NOTES - 1 }, (_, i) => ({
            _id: new ObjectId(),
            text: `n${i}`,
            at: new Date(),
          })),
        },
      },
    },
  );
  const full = await admin('POST', `/admin/customers/${asha.id}/notes`, { text: 'One too many' });
  assert.equal(full.status, 409);
  await t.db
    .collection('users')
    .updateOne({ email: 'asha@example.com' }, { $pull: { adminNotes: { text: /^n\d+$/ } } });
});

test('admin order pages show the customer’s tags and notes; help cards their tags; customers never see them', async () => {
  const p = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const quote = await asha('GET', `/cart?items=${p._id}:1`);
  const order = (
    await asha('POST', '/orders', {
      items: [{ productId: p._id.toString(), qty: 1 }],
      address,
      expectedTotal: quote.body.total,
    })
  ).body;
  const seen = (await admin('GET', `/admin/orders/${order.id}`)).body.customer;
  assert.deepEqual(seen.tags, ['vip', 'wholesale']);
  assert.deepEqual(
    seen.notes.map((n) => n.text),
    ['Runs a small shop; buys in bulk at Diwali'],
  );
  assert.deepEqual((await admin('GET', '/admin/orders')).body.items[0].customer.tags, ['vip', 'wholesale']);

  await t.db.collection('rateLimits').deleteMany({});
  await asha('POST', '/help', { topic: 'other', message: 'Can you deliver on Sunday?' });
  const card = (await support('GET', '/admin/help')).body.items[0];
  assert.deepEqual(card.customer.tags, ['vip', 'wholesale']);

  const me = JSON.stringify((await asha('GET', '/auth/me')).body);
  assert.ok(!me.includes('Diwali') && !me.includes('wholesale'));
  assert.ok(!JSON.stringify((await asha('GET', `/orders/${order.id}`)).body).includes('Diwali'));
  // Their own data download does include what was noted about them.
  const data = (await asha('GET', '/account/data')).body.account;
  assert.deepEqual(data.storeTags, ['vip', 'wholesale']);
  assert.equal(data.storeNotes[0].text, 'Runs a small shop; buys in bulk at Diwali');
});

test('only admins write tags and notes', async () => {
  assert.equal((await support('PUT', `/admin/customers/${asha.id}/tags`, { tags: [] })).status, 403);
  assert.equal((await support('POST', `/admin/customers/${asha.id}/notes`, { text: 'Hello there' })).status, 403);
  assert.equal((await asha('POST', `/admin/customers/${asha.id}/notes`, { text: 'Hello there' })).status, 403);
  assert.equal((await admin('PUT', '/admin/customers/000000000000000000000000/tags', { tags: [] })).status, 404);
});
