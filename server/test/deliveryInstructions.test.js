import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

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

async function order(instructions) {
  const book = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const quote = await customer('GET', `/cart?items=${book._id}:1`);
  return customer('POST', '/orders', {
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
    ...(instructions !== undefined && { instructions }),
  });
}

test('an order keeps its delivery instructions, shown to admins in the alert', async () => {
  const res = await order('  Call before coming; leave it with the guard  ');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.deliveryInstructions, 'Call before coming; leave it with the guard');
  const alert = t.mail.sent.findLast((m) => m.to.email === 'admin@example.com' && /^New order/.test(m.subject));
  assert.match(alert.text, /Delivery instructions: "Call before coming; leave it with the guard"/);
  assert.equal((await order()).body.deliveryInstructions, '');
  assert.equal((await order('x'.repeat(201))).status, 400);
});

test('the customer and admins change them until it ships; a customer change tells the admins', async () => {
  const { body: placed } = await order('Ring twice');
  const change = (call, path, instructions) => call('POST', path, { instructions });
  const mine = `/orders/${placed.id}/instructions`;

  const res = await change(customer, mine, 'Leave at the door');
  assert.equal(res.status, 200);
  assert.equal(res.body.deliveryInstructions, 'Leave at the door');
  const alert = t.mail.sent.findLast((m) => m.subject === `Order #${placed.number}: new delivery instructions`);
  assert.match(alert.text, /Now: "Leave at the door"/);
  assert.equal((await change(t.browser(), mine, 'x')).status, 401);
  assert.equal((await change(admin, mine, 'x')).status, 404); // not the admin's own order

  const theirs = `/admin/orders/${placed.id}/instructions`;
  assert.equal((await change(customer, theirs, 'x')).status, 403);
  const cleared = await change(admin, theirs, '');
  assert.equal(cleared.body.deliveryInstructions, '');
  const log = await t.db.collection('activity').findOne({ action: 'Changed delivery instructions' });
  assert.deepEqual(log.changes, [{ field: 'Delivery instructions', from: 'Leave at the door', to: 'none' }]);

  assert.equal((await admin('POST', `/admin/orders/${placed.id}/status`, { status: 'shipped' })).status, 200);
  const late = await change(customer, mine, 'Too late');
  assert.equal(late.status, 409);
  assert.match(late.body.error, /before the order ships/);
});
