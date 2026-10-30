import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { codeAt, stepOf } from '../src/totp.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
});
after(() => t.stop());

async function register(email, name = 'Asha Rao') {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  call.email = email;
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
const product = (slug) => t.db.collection('products').findOne({ slug });

// A customer with a delivered order of the book, a review of it, an answered and an unanswered question, a wishlist
// item, a saved address and a help request.
async function customerWithHistory(email) {
  const call = await register(email);
  const book = await product('the-quiet-engineer-paperback');
  const items = [{ productId: book._id.toString(), qty: 1 }];
  const quote = await call('GET', `/cart?items=${items[0].productId}:1`);
  const order = (await call('POST', '/orders', { items, address, expectedTotal: quote.body.total })).body;
  await admin('POST', `/admin/orders/${order.id}/status`, { status: 'shipped' });
  await admin('POST', `/admin/orders/${order.id}/status`, { status: 'delivered' });
  assert.equal(
    (await call('PUT', `/products/${book.slug}/review`, { rating: 2, body: 'Too slow for me.' })).status,
    200,
  );
  const asked = (await call('POST', `/products/${book.slug}/questions`, { text: `Is there an audiobook? (${email})` }))
    .body;
  await admin('PUT', `/admin/questions/${asked.id}/answer`, { text: 'Not yet.' });
  await call('POST', `/products/${book.slug}/questions`, { text: `Is there a hardback edition? (${email})` });
  await call('PUT', `/wishlist/${book._id}`);
  await call('POST', '/help', { topic: 'other', message: 'Do you sell gift cards?' });
  return { call, order, book };
}

test('customers download everything the store holds about them, without secrets', async () => {
  await t.db.collection('rateLimits').deleteMany({});
  const { call, order } = await customerWithHistory('asha@example.com');
  assert.equal((await t.call('GET', '/account/data')).status, 401);
  const res = await call('GET', '/account/data');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="bazaar-my-data-\d{4}-\d\d-\d\d\.json"$/);
  const data = res.body;
  assert.equal(data.account.email, 'asha@example.com');
  assert.equal(data.account.addresses[0].line1, '12 MG Road');
  assert.deepEqual(data.account.emails, { priceDrops: true, cartReminders: true, reviewReminders: true });
  assert.deepEqual(
    data.orders.map((o) => o.id),
    [order.id],
  );
  assert.equal(data.reviews[0].product, 'The Quiet Engineer (Paperback)');
  assert.equal(data.questions.length, 2);
  assert.equal(data.wishlist.length, 1);
  assert.equal(data.helpRequests[0].messages[0].text, 'Do you sell gift cards?');
  const raw = JSON.stringify(data);
  for (const secret of ['passwordHash', 'scrypt$', 'tokenHash', 'totp', 'recoveryHashes']) {
    assert.equal(raw.includes(secret), false, secret);
  }
});

test('closing an account deletes what is theirs, anonymises the rest and keeps orders for tax', async () => {
  const { call, order, book } = await (async () => {
    await t.db.collection('rateLimits').deleteMany({});
    return customerWithHistory('ravi@example.com');
  })();
  const ratingBefore = (await product(book.slug)).rating;
  const user = await t.db.collection('users').findOne({ email: 'ravi@example.com' });

  assert.equal((await call('POST', '/account/close', { password: 'password123' })).status, 400); // no confirm
  const wrong = await call('POST', '/account/close', { password: 'nope', confirm: true });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, 'Your password is wrong');

  const res = await call('POST', '/account/close', { password: 'password123', confirm: true });
  assert.equal(res.status, 204);
  assert.match(res.setCookie, /^sid=;/);
  assert.equal((await call('GET', '/auth/me')).body.user, null);

  const db = t.db;
  assert.equal(await db.collection('users').countDocuments({ _id: user._id }), 0);
  for (const name of ['sessions', 'wishlist', 'helpRequests', 'reviews']) {
    assert.equal(await db.collection(name).countDocuments({ userId: user._id }), 0, name);
  }
  assert.equal(await db.collection('carts').countDocuments({ _id: user._id }), 0);
  // The review left the rating; the answered question stays, unsigned; the unanswered one is gone.
  const ratingAfter = (await product(book.slug)).rating;
  assert.equal(ratingAfter.count, ratingBefore.count - 1);
  const questions = await db.collection('questions').find({ productId: book._id }).toArray();
  const answered = questions.find((q) => q.text === 'Is there an audiobook? (ravi@example.com)');
  assert.deepEqual([answered.author, answered.userId], ['A customer', null]);
  // The admin list still shows it, with no customer.
  const listed = (await admin('GET', '/admin/questions?status=answered')).body.items.find(
    (q) => q.id === answered._id.toString(),
  );
  assert.equal(listed.customer, null);
  assert.equal(listed.author, 'A customer');
  assert.equal(
    questions.some((q) => q.text === 'Is there a hardback edition? (ravi@example.com)'),
    false,
  );
  // The order stays, without the name, phone or street; the place of supply remains.
  const kept = await db
    .collection('orders')
    .findOne({ _id: (await db.collection('orders').findOne({ number: order.number }))._id });
  assert.deepEqual(
    [
      kept.address.name,
      kept.address.phone,
      kept.address.line1,
      kept.address.city,
      kept.address.state,
      kept.address.pincode,
    ],
    ['Closed account', '', '', 'Bengaluru', 'Karnataka', '560001'],
  );
  assert.equal(kept.total, order.total);

  // They're told, and the address can sign up again.
  const [mail] = t.mail.sent.filter((m) => m.to.email === 'ravi@example.com' && /closed/.test(m.subject));
  assert.equal(mail.subject, 'Your Bazaar account was closed');
  assert.equal(
    (
      await t.browser()('POST', '/auth/register', {
        name: 'Ravi K',
        email: 'ravi@example.com',
        password: 'password123',
      })
    ).status,
    201,
  );
});

test('not while an order is on its way or a return is open, never for admins, and with the two-step code', async () => {
  await t.db.collection('rateLimits').deleteMany({});
  const call = await register('meera@example.com', 'Meera Iyer');
  const book = await product('the-quiet-engineer-paperback');
  const items = [{ productId: book._id.toString(), qty: 1 }];
  const quote = await call('GET', `/cart?items=${items[0].productId}:1`);
  const order = (await call('POST', '/orders', { items, address, expectedTotal: quote.body.total })).body;
  const onItsWay = await call('POST', '/account/close', { password: 'password123', confirm: true });
  assert.equal(onItsWay.status, 409);
  assert.match(onItsWay.body.error, /still on its way/);

  await admin('POST', `/admin/orders/${order.id}/status`, { status: 'shipped' });
  await admin('POST', `/admin/orders/${order.id}/status`, { status: 'delivered' });
  assert.equal(
    (await call('POST', `/orders/${order.id}/returns`, { items: [{ index: 0, qty: 1 }], reason: 'changed_mind' }))
      .status,
    201,
  );
  const returning = await call('POST', '/account/close', { password: 'password123', confirm: true });
  assert.equal(returning.status, 409);
  assert.match(returning.body.error, /return in progress/);

  const adminClose = await admin('POST', '/account/close', { password: 'password123', confirm: true });
  assert.equal(adminClose.status, 409);

  // With two-step login on, the code is needed too.
  const twoStep = await register('kiran@example.com', 'Kiran S');
  const setup = await twoStep('POST', '/account/two-step/setup', { password: 'password123' });
  assert.equal(
    (await twoStep('POST', '/account/two-step/enable', { code: codeAt(setup.body.secret, stepOf()) })).status,
    200,
  );
  const noCode = await twoStep('POST', '/account/close', { password: 'password123', confirm: true });
  assert.equal(noCode.status, 400);
  assert.match(noCode.body.error, /code from your authenticator app/);
  const withCode = await twoStep('POST', '/account/close', {
    password: 'password123',
    code: codeAt(setup.body.secret, stepOf() + 1),
    confirm: true,
  });
  assert.equal(withCode.status, 204);
});
