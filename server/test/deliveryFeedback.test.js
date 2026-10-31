import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import * as client from '../../client/src/deliveryFeedback.js';
import { DELIVERY_RATINGS, FEEDBACK_DAYS, MAX_NOTE } from '../src/deliveryFeedback.js';

const DAY = 86_400_000;
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

// Ships (with `courier`, if any) and delivers a new order.
async function delivered(courier) {
  const o = await order();
  const ship = await admin('POST', `/admin/orders/${o.id}/status`, {
    status: 'shipped',
    ...(courier !== undefined && { shipment: { courier } }),
  });
  assert.equal(ship.status, 200, JSON.stringify(ship.body));
  assert.equal((await admin('POST', `/admin/orders/${o.id}/status`, { status: 'delivered' })).status, 200);
  return o;
}
const answer = (o, body, call = customer) => call('POST', `/orders/${o.id}/delivery-feedback`, body);

test('the order page offers the choices the server takes', () => {
  assert.deepEqual(client.DELIVERY_RATINGS, DELIVERY_RATINGS);
  assert.equal(client.FEEDBACK_DAYS, FEEDBACK_DAYS);
  assert.equal(client.MAX_NOTE, MAX_NOTE);
});

test('a customer says how the delivery went, and can change it', async () => {
  const o = await delivered('Blue Dart');
  const res = await answer(o, { rating: 'late', note: '  Two days after the date  ' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.deliveryFeedback.rating, 'late');
  assert.equal(res.body.deliveryFeedback.note, 'Two days after the date');
  const again = await answer(o, { rating: 'on_time' });
  assert.deepEqual(
    { ...again.body.deliveryFeedback, at: undefined },
    { rating: 'on_time', at: undefined }, // the note went with the old answer
  );
  assert.equal((await admin('GET', `/admin/orders/${o.id}`)).body.deliveryFeedback.rating, 'on_time');
});

test('only for the customer’s own delivered orders, within the window, with a valid answer', async () => {
  const o = await delivered('Blue Dart');
  assert.equal((await answer(o, { rating: 'great' })).status, 400);
  assert.equal((await answer(o, {})).status, 400);
  assert.equal((await answer(o, { rating: 'late', note: 'x'.repeat(MAX_NOTE + 1) })).status, 400);
  assert.equal((await answer(o, { rating: 'late' }, t.browser())).status, 401);
  assert.equal((await answer(o, { rating: 'late' }, admin)).status, 404); // not the admin's order

  const waiting = await order();
  const early = await answer(waiting, { rating: 'on_time' });
  assert.equal(early.status, 409);
  assert.match(early.body.error, /once it arrives/);

  await t.db
    .collection('orders')
    .updateOne({ number: o.number }, { $set: { deliveredAt: new Date(Date.now() - (FEEDBACK_DAYS + 1) * DAY) } });
  const late = await answer(o, { rating: 'on_time' });
  assert.equal(late.status, 409);
  assert.match(late.body.error, /30 days after delivery/);
  // Cancel the waiting one, for the closing test.
  assert.equal((await customer('POST', `/orders/${waiting.id}/cancel`)).status, 200);
});

test('admins see answers per courier, and orders that came after the promised date', async () => {
  await t.db.collection('orders').deleteMany({});
  const a = await delivered('Delhivery');
  const b = await delivered(' delhivery ');
  const c = await delivered('Delhivery');
  const d = await delivered('India Post');
  await delivered(); // no courier entered
  await answer(a, { rating: 'on_time' });
  await answer(b, { rating: 'damaged', note: 'Box crushed on one side' });
  await answer(d, { rating: 'late' });
  // c came after its date; d had none (an order from before delivery dates).
  const orders = t.db.collection('orders');
  await orders.updateOne({ number: c.number }, { $set: { 'deliveryEstimate.to': '2020-01-01' } });
  await orders.updateOne({ number: a.number }, { $set: { 'deliveryEstimate.to': '2999-01-01' } });
  await orders.updateOne({ number: d.number }, { $unset: { deliveryEstimate: '' } });

  const res = await admin('GET', '/admin/delivery-feedback?days=30');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(
    res.body.couriers.map((x) => [x.courier, x.delivered, x.answers, x.onTime, x.late, x.damaged, x.afterDate]),
    [
      ['Delhivery', 3, 2, 1, 0, 1, 1],
      ['', 1, 0, 0, 0, 0, 0],
      ['India Post', 1, 1, 0, 1, 0, 0],
    ],
  );
  assert.equal(res.body.couriers[2].withDate, 0);
  assert.deepEqual(
    res.body.notes.map((n) => [n.courier, n.rating, n.note]),
    [['delhivery', 'damaged', 'Box crushed on one side']],
  );
  assert.equal((await admin('GET', '/admin/delivery-feedback?days=7')).status, 400);
  assert.equal((await customer('GET', '/admin/delivery-feedback')).status, 403);
});

test('closing the account removes the notes but keeps the answers', async () => {
  const res = await customer('POST', '/account/close', { password: 'password123', confirm: true });
  assert.equal(res.status, 204, JSON.stringify(res.body));
  const answered = await t.db
    .collection('orders')
    .find({ deliveryFeedback: { $exists: true } })
    .toArray();
  assert.equal(answered.length, 3);
  assert.ok(answered.every((o) => o.deliveryFeedback.note === undefined));
});
