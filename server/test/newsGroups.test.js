import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { sendNewsletters } from '../src/newsletters.js';

// Store news for a group (stage 143).
let t;
let admin;
const ids = {};
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  // Four subscribers and one who isn't.
  for (const name of ['Asha', 'Ravi', 'Meera', 'Kiran', 'Dev']) {
    const call = t.browser();
    const email = `${name.toLowerCase()}@example.com`;
    await call('POST', '/auth/register', { name: `${name} Rao`, email, password: 'password123' });
    if (name !== 'Dev') await call('PUT', '/account/email-preferences', { newsEmails: true });
    ids[name] = (await t.db.collection('users').findOne({ email }))._id;
  }
  await t.db.collection('users').updateMany({ _id: { $in: [ids.Asha, ids.Dev] } }, { $set: { tags: ['vip'] } });
  // Ravi bought a book (delivered, ₹6,000 so Silver at a low bar); Meera's book order was cancelled; Dev bought one too.
  const book = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const order = (userId, status, total) => ({
    userId,
    items: [{ productId: book._id, title: book.title, price: total, qty: 1 }],
    subtotal: total,
    delivery: 0,
    discount: 0,
    total,
    status,
    payment: { method: 'cod' },
    createdAt: new Date(),
    deliveredAt: new Date(),
  });
  await t.db
    .collection('orders')
    .insertMany([
      order(ids.Ravi, 'delivered', 600000),
      order(ids.Meera, 'cancelled', 34900),
      order(ids.Dev, 'delivered', 34900),
    ]);
});
after(() => t.stop());

const count = async (group) => (await admin('GET', `/admin/newsletters/group?group=${encodeURIComponent(group)}`)).body;
const books = () => t.db.collection('categories').findOne({ slug: 'books' });

test('groups count only subscribers in them', async () => {
  assert.deepEqual(await count('all'), { group: 'all', label: 'Everyone subscribed', count: 4 });
  assert.deepEqual(await count('tag:vip'), { group: 'tag:vip', label: 'Customers tagged VIP', count: 1 });
  const category = await books();
  assert.deepEqual(await count(`category:${category._id}`), {
    group: `category:${category._id}`,
    label: 'Customers who bought from Books',
    count: 1, // Ravi: Meera's was cancelled, Dev isn't subscribed
  });
  for (const bad of ['everyone', 'tag:gold', 'category:123', 'loyalty:bronze']) {
    assert.equal((await admin('GET', `/admin/newsletters/group?group=${bad}`)).status, 400, bad);
  }
  const gone = await admin('GET', '/admin/newsletters/group?group=category:0123456789abcdef01234567');
  assert.equal(gone.status, 400);
  assert.match(gone.body.error, /no longer exists/);
  // Loyalty groups need loyalty levels on.
  const off = await admin('GET', '/admin/newsletters/group?group=loyalty:silver');
  assert.equal(off.status, 409);
  await admin('PUT', '/admin/loyalty', {
    enabled: true,
    silver: { spend: 500000, freeDeliveryMin: 29900, extraCashback: 0 },
    gold: { spend: 2000000, freeDeliveryMin: 0, extraCashback: 0 },
  });
  assert.equal((await count('loyalty:silver')).count, 1);
  assert.equal((await count('loyalty:silver')).label, 'Silver and Gold members');
  assert.equal((await count('loyalty:gold')).count, 0);
  assert.equal((await t.call('GET', '/admin/newsletters/group?group=all')).status, 401);
});

test('an email sent to a group goes only to its subscribers, and says so', async () => {
  const draft = await admin('POST', '/admin/newsletters', {
    subject: 'For our VIPs',
    body: 'Thank you for shopping with us so often.',
    group: 'tag:vip',
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  assert.equal(draft.body.groupLabel, 'Customers tagged VIP');
  const sent = await admin('POST', `/admin/newsletters/${draft.body.id}/send`);
  assert.equal(sent.body.recipients, 1);
  t.mail.sent.length = 0;
  await sendNewsletters(t.ctx);
  assert.deepEqual(
    t.mail.sent.map((m) => m.to.email),
    ['asha@example.com'],
  );
  const log = await t.db.collection('activity').findOne({ action: 'Sent store news' });
  assert.deepEqual(log.changes, [
    { field: 'Sent to', to: 'Customers tagged VIP' },
    { field: 'Subscribers', to: '1' },
  ]);

  // A group with no subscribers can't be sent to; a draft can change its group.
  const empty = await admin('POST', '/admin/newsletters', {
    subject: 'Gold only',
    body: 'Something for our Gold members.',
    group: 'loyalty:gold',
  });
  const refused = await admin('POST', `/admin/newsletters/${empty.body.id}/send`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'Nobody in this group has asked for store news');
  const edited = await admin('PUT', `/admin/newsletters/${empty.body.id}`, {
    subject: 'Gold only',
    body: 'Something for our Gold members.',
    group: 'all',
  });
  assert.equal(edited.body.groupLabel, 'Everyone subscribed');
});
