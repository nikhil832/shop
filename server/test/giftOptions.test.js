import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
before(async () => {
  t = await startTestServer();
  admin = await register('admin@example.com', 'Store Admin');
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  customer = await register('asha@example.com', 'Asha Rao');
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name, email, password: 'password123' });
  assert.equal(res.status, 201);
  return call;
}

const address = {
  name: 'Ravi Kumar',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
const bookId = async () =>
  (await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' }))._id.toString();
const quote = async (wrap = false) =>
  (await customer('GET', `/cart?items=${await bookId()}:2${wrap ? '&giftWrap=1' : ''}`)).body;
const order = async (gift, expectedTotal) =>
  customer('POST', '/orders', {
    items: [{ productId: await bookId(), qty: 2 }],
    address,
    expectedTotal,
    gift,
  });

test('admins switch gift wrapping on and set its fee (checked and logged)', async () => {
  assert.deepEqual((await admin('GET', '/admin/gift-wrap')).body, { enabled: false, fee: 4900 });
  assert.equal((await customer('GET', '/admin/gift-wrap')).status, 403);
  for (const [fee, error] of [
    [50, 'At least ₹1'],
    [60000, 'At most ₹500'],
    [4950, 'Whole rupees only'],
  ]) {
    const res = await admin('PUT', '/admin/gift-wrap', { enabled: true, fee });
    assert.equal(res.status, 400);
    assert.match(res.body.error, new RegExp(error));
  }
  assert.equal((await admin('PUT', '/admin/gift-wrap', { enabled: true, fee: 3900 })).status, 200);
  const log = await t.db.collection('activity').findOne({ action: 'Changed gift wrapping' });
  assert.deepEqual(log.changes, [
    { field: 'Offered', from: 'no', to: 'yes' },
    { field: 'Fee', from: '₹49', to: '₹39' },
  ]);
  await admin('PUT', '/admin/gift-wrap', { enabled: false, fee: 3900 });
});

test('a gift message costs nothing; wrapping only when offered, its fee in the quote and the order', async () => {
  // Off: no offer, and wrapping is refused.
  const plain = await quote(true);
  assert.equal(plain.giftWrapOffer, null);
  assert.equal(plain.giftWrap, 0);
  assert.equal((await order({ message: 'Happy birthday!', wrap: true }, plain.total)).status, 409);

  // A message alone.
  const gift = await order({ message: '  Happy birthday, Ravi!  ' }, plain.total);
  assert.equal(gift.status, 201, JSON.stringify(gift.body));
  assert.deepEqual(gift.body.gift, { message: 'Happy birthday, Ravi!', wrap: false });
  assert.equal(gift.body.giftWrap, 0);
  const mail = t.mail.sent.findLast((m) => m.to.email === 'asha@example.com' && /Order #/.test(m.subject));
  assert.match(
    mail.text,
    /It's a gift, with your message: "Happy birthday, Ravi!"\. Prices are left off the packing slip\./,
  );
  const alert = t.mail.sent.findLast((m) => m.to.email === 'admin@example.com' && /^New order/.test(m.subject));
  assert.match(alert.text, /It's a gift\. Message: "Happy birthday, Ravi!"/);

  // On: the quote offers it and adds the fee when chosen; the order must have been shown that total.
  await admin('PUT', '/admin/gift-wrap', { enabled: true, fee: 4900 });
  const offered = await quote();
  assert.deepEqual(offered.giftWrapOffer, { fee: 4900 });
  const wrapped = await quote(true);
  assert.equal(wrapped.giftWrap, 4900);
  assert.equal(wrapped.total, offered.total + 4900);
  assert.equal((await order({ message: '', wrap: true }, offered.total)).status, 409); // shown without the fee
  const res = await order({ message: '', wrap: true }, wrapped.total);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.giftWrap, 4900);
  assert.equal(res.body.total, res.body.subtotal + res.body.delivery + 4900 - res.body.discount);
  const confirmation = t.mail.sent.findLast((m) => m.to.email === 'asha@example.com' && /Order #/.test(m.subject));
  assert.match(confirmation.text, /Gift wrapping/);

  // Cancelling one item keeps the wrapping fee, like delivery.
  const cancelled = await customer('POST', `/orders/${res.body.id}/cancel-items`, { items: [{ index: 0, qty: 1 }] });
  assert.equal(cancelled.body.total, cancelled.body.subtotal + cancelled.body.delivery + 4900);

  assert.equal((await order({ message: 'x'.repeat(201) }, plain.total)).status, 400);
});
