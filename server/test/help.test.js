import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_OPEN, NEW_PER_HOUR } from '../src/routes/help.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let customer;
let order;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  customer = await register('asha@example.com', 'Asha Rao');
  const book = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const items = [{ productId: book._id.toString(), qty: 1 }];
  const quote = await customer('GET', `/cart?items=${items[0].productId}:1`);
  const address = {
    name: 'Asha Rao',
    phone: '9876543210',
    line1: '12 MG Road',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
  };
  order = (await customer('POST', '/orders', { items, address, expectedTotal: quote.body.total })).body;
});
after(() => t.stop());

async function register(email, name) {
  const call = t.browser();
  assert.equal((await call('POST', '/auth/register', { name, email, password: 'password123' })).status, 201);
  return call;
}
const resetLimits = () => t.db.collection('rateLimits').deleteMany({});
const sentTo = (email, subject) => t.mail.sent.filter((m) => m.to.email === email && subject.test(m.subject));

test('a customer asks about an order; admins are emailed and answer; the customer is emailed and sees it', async () => {
  await resetLimits();
  const res = await customer('POST', '/help', { topic: 'order', orderId: order.id, message: 'Where is my parcel?' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.number, 1);
  assert.equal(res.body.status, 'waiting');
  assert.equal(res.body.orderId, order.id);
  const [alert] = sentTo('owner@example.com', /^Help request #1 from Asha Rao about order #/);
  assert.match(alert.text, /Where is my parcel\?/);

  // The admin inbox: waiting first, with who and which order.
  const inbox = (await admin('GET', '/admin/help')).body;
  assert.deepEqual(inbox.counts, { waiting: 1, answered: 0, closed: 0 });
  assert.deepEqual(inbox.items[0].customer, { name: 'Asha Rao', email: 'asha@example.com', guest: false });
  assert.equal(inbox.items[0].orderNumber, order.number);
  assert.equal((await admin('GET', '/admin/dashboard')).body.helpWaiting, 1);
  assert.equal((await admin('GET', `/admin/help?orderId=${order.id}`)).body.items.length, 1);

  const reply = await admin('POST', `/admin/help/${res.body.id}/reply`, { text: 'It ships tomorrow.' });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.status, 'answered');
  assert.deepEqual(
    reply.body.messages.map((m) => [m.from, m.by, m.text]),
    [
      ['customer', null, 'Where is my parcel?'],
      ['store', 'Store Owner', 'It ships tomorrow.'],
    ],
  );
  const [mail] = sentTo('asha@example.com', /^Re: your help request #1$/);
  assert.match(mail.text, /^Hi Asha,\n\nIt ships tomorrow\./);
  assert.match(mail.text, new RegExp(`https://bazaar.test/help/${res.body.id}`));
  const logged = (await admin('GET', '/admin/activity?area=help')).body.items[0];
  assert.equal(logged.action, 'Answered help request');

  // The customer sees it and writes again: waiting, admins told.
  assert.equal((await customer('GET', '/help')).body.items[0].status, 'answered');
  const again = await customer('POST', `/help/${res.body.id}/messages`, { text: 'Thank you, and the invoice?' });
  assert.equal(again.body.status, 'waiting');
  assert.equal(sentTo('owner@example.com', /wrote again$/).length, 1);
});

test('guests write with a name and email and get replies by email only', async () => {
  await resetLimits();
  assert.equal((await t.call('POST', '/help', { topic: 'product', message: 'Do you ship to Goa?' })).status, 400);
  const guest = await t.call('POST', '/help', {
    topic: 'product',
    message: 'Do you ship to Goa?',
    name: 'Kiran S',
    email: 'Kiran@Example.com',
  });
  assert.equal(guest.status, 201);
  assert.equal(
    (
      await t.call('POST', '/help', {
        topic: 'order',
        orderId: order.id,
        message: 'Mine?',
        name: 'K',
        email: 'k@example.com',
      })
    ).status,
    401,
  );
  await admin('POST', `/admin/help/${guest.body.id}/reply`, { text: 'Yes, everywhere in India.' });
  const [mail] = sentTo('kiran@example.com', /^Re: your help request/);
  assert.match(mail.text, /write to us again: https:\/\/bazaar.test\/help$/m);
  // Guests can't open threads (no login), and nobody sees another's.
  assert.equal((await t.call('GET', `/help/${guest.body.id}`)).status, 401);
  assert.equal((await customer('GET', `/help/${guest.body.id}`)).status, 404);
  assert.equal((await customer('POST', `/help/${guest.body.id}/messages`, { text: 'Hello there' })).status, 404);
});

test('requests are checked and limited', async () => {
  await resetLimits();
  for (const [body, error] of [
    [{ topic: 'gossip', message: 'Hello there' }, /Choose what it is about/],
    [{ topic: 'other', message: 'Hi' }, /at least a few words/],
    [{ topic: 'other', message: 'x'.repeat(2001) }, /At most 2000/],
    [{ topic: 'order', orderId: '000000000000000000000000', message: 'Which order?' }, /Order not found/],
  ]) {
    const res = await customer('POST', '/help', body);
    assert.ok(res.status === 400 || res.status === 404, JSON.stringify(res.body));
    assert.match(res.body.error, error);
  }
  // Another customer's order isn't theirs to ask about.
  const other = await register('ravi@example.com', 'Ravi K');
  assert.equal(
    (await other('POST', '/help', { topic: 'order', orderId: order.id, message: 'Is this mine?' })).status,
    404,
  );

  // Five new requests an hour from one network.
  for (let i = 0; i < NEW_PER_HOUR; i++) {
    assert.equal((await other('POST', '/help', { topic: 'other', message: `Question number ${i}` })).status, 201);
  }
  assert.equal((await other('POST', '/help', { topic: 'other', message: 'One more question' })).status, 429);

  // And at most MAX_OPEN open per account.
  await resetLimits();
  const ravi = await t.db.collection('users').findOne({ email: 'ravi@example.com' });
  await t.db.collection('helpRequests').insertMany(
    Array.from({ length: MAX_OPEN - NEW_PER_HOUR }, (_, i) => ({
      number: 900 + i,
      userId: ravi._id,
      name: 'Ravi K',
      email: 'ravi@example.com',
      topic: 'other',
      orderId: null,
      status: 'waiting',
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
  const tooMany = await other('POST', '/help', { topic: 'other', message: 'Eleventh question' });
  assert.equal(tooMany.status, 429);
  assert.match(tooMany.body.error, /10 open requests/);
});

test('admins close and reopen (logged once); a customer writing to a closed one opens it again', async () => {
  const [first] = (await customer('GET', '/help')).body.items.filter((r) => r.number === 1);
  assert.equal((await customer('POST', `/admin/help/${first.id}/status`, { status: 'closed' })).status, 403);
  assert.equal((await admin('POST', `/admin/help/${first.id}/status`, { status: 'done' })).status, 400);
  assert.equal((await admin('POST', '/admin/help/000000000000000000000000/status', { status: 'closed' })).status, 404);
  await admin('POST', `/admin/help/${first.id}/status`, { status: 'closed' });
  await admin('POST', `/admin/help/${first.id}/status`, { status: 'closed' });
  const closings = (await admin('GET', '/admin/activity?area=help')).body.items.filter(
    (e) => e.action === 'Closed help request',
  );
  assert.equal(closings.length, 1);
  assert.equal((await admin('GET', '/admin/help?status=closed')).body.items[0].id, first.id);

  const reopened = await customer('POST', `/help/${first.id}/messages`, { text: 'Sorry, one more thing.' });
  assert.equal(reopened.body.status, 'waiting');
  const back = await admin('POST', `/admin/help/${first.id}/status`, { status: 'closed' });
  assert.equal(back.body.status, 'closed');
  assert.equal((await admin('POST', `/admin/help/${first.id}/status`, { status: 'open' })).body.status, 'waiting');
  assert.equal((await t.call('GET', '/admin/help')).status, 401);
});
