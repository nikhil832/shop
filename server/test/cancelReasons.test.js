import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import * as client from '../../client/src/cancelReasons.js';
import { CANCEL_REASONS, MAX_NOTE } from '../src/cancelReasons.js';

let t;
let admin;
let customer;
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  customer = t.browser();
  await customer('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
});
after(() => t.stop());

async function order() {
  const book = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const quote = await customer('GET', `/cart?items=${book._id}:1`);
  const res = await customer('POST', '/orders', {
    items: [{ productId: book._id.toString(), qty: 1 }],
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
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
const cancel = (o, body) => customer('POST', `/orders/${o.id}/cancel`, body);

test('the form offers the reasons the server takes', () => {
  assert.deepEqual(client.CANCEL_REASONS, CANCEL_REASONS);
  assert.equal(client.MAX_NOTE, MAX_NOTE);
});

test('a customer says why they cancel; admins see it on the order', async () => {
  const o = await order();
  const res = await cancel(o, { reason: 'cheaper', note: '  Same book for less at the corner shop  ' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'cancelled');
  assert.deepEqual(res.body.cancelReason, { reason: 'cheaper', note: 'Same book for less at the corner shop' });
  const seen = await admin('GET', `/admin/orders/${o.id}`);
  assert.deepEqual(seen.body.cancelReason, res.body.cancelReason);

  // Without a reason (a page from before) it still cancels, with none recorded; a note alone counts as "other".
  const plain = await cancel(await order());
  assert.equal(plain.status, 200);
  assert.equal(plain.body.cancelReason, null);
  const noteOnly = await cancel(await order(), { note: 'Gift no longer needed' });
  assert.deepEqual(noteOnly.body.cancelReason, { reason: 'other', note: 'Gift no longer needed' });
  assert.deepEqual((await cancel(await order(), { reason: 'mistake', note: '   ' })).body.cancelReason, {
    reason: 'mistake',
  });
});

test('bad reasons and long notes are refused, and nothing is cancelled', async () => {
  const o = await order();
  const bad = await cancel(o, { reason: 'bored' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Choose a reason/);
  assert.equal((await cancel(o, { reason: 'other', note: 'x'.repeat(MAX_NOTE + 1) })).status, 400);
  assert.equal((await t.db.collection('orders').findOne({ number: o.number })).status, 'placed');
});

test('the dashboard counts customers’ reasons and shows their latest notes', async () => {
  // A store cancellation isn't the customer's, so it isn't counted.
  const byStore = await order();
  assert.equal((await admin('POST', `/admin/orders/${byStore.id}/status`, { status: 'cancelled' })).status, 200);
  await cancel(await order(), { reason: 'cheaper' });

  const { body } = await admin('GET', '/admin/dashboard?days=7');
  // Earlier tests: cheaper (with a note), none, other (note), mistake; plus cheaper here.
  assert.deepEqual(body.cancelReasons.reasons, [
    { reason: 'cheaper', count: 2 },
    { reason: null, count: 1 },
    { reason: 'mistake', count: 1 },
    { reason: 'other', count: 1 },
  ]);
  assert.deepEqual(
    body.cancelReasons.notes.map((n) => [n.reason, n.note]),
    [
      ['other', 'Gift no longer needed'],
      ['cheaper', 'Same book for less at the corner shop'],
    ],
  );
  assert.ok(body.cancelReasons.notes.every((n) => n.orderId && n.number && n.at));
  assert.equal((await customer('GET', '/admin/dashboard?days=7')).status, 403);
});

test('closing the account removes the notes but keeps the reasons', async () => {
  // The order the bad requests left placed must go first.
  for (const o of await t.db.collection('orders').find({ status: 'placed' }).toArray()) {
    assert.equal((await customer('POST', `/orders/${o._id}/cancel`, { reason: 'too_slow' })).status, 200);
  }
  const res = await customer('POST', '/account/close', { password: 'password123', confirm: true });
  assert.equal(res.status, 204, JSON.stringify(res.body));
  const left = await t.db
    .collection('orders')
    .find({ 'cancelReason.reason': { $exists: true } })
    .toArray();
  assert.ok(left.length >= 4);
  assert.ok(left.every((o) => o.cancelReason.note === undefined));
});
