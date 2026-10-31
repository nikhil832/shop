import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { startTestServer } from './helpers.js';

let t;
let admin;
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
});
after(() => t.stop());

const DAY = 86_400_000;
// An order of `total` paise by `userId`, stored directly `daysAgo` days ago (plus an hour, to stay off midnight).
async function addOrder(userId, daysAgo, total, status = 'delivered') {
  const createdAt = new Date(Date.now() - daysAgo * DAY - 3_600_000);
  await t.db.collection('orders').insertOne({ userId, items: [], total, status, createdAt, updatedAt: createdAt });
}

test('the dashboard tells new customers from returning ones', async () => {
  const [asha, ben, chitra, dev, esha] = Array.from({ length: 5 }, () => new ObjectId());
  // Asha: bought 40 days ago, came back 10 days ago and 4 days ago (returning).
  await addOrder(asha, 40, 50000);
  await addOrder(asha, 10, 30000);
  await addOrder(asha, 4, 20000);
  // Ben: first order 5 days ago, and again 2 days ago (new, ordered twice).
  await addOrder(ben, 5, 70000);
  await addOrder(ben, 2, 10000);
  // Chitra: only before the period. Dev: one new order. Esha: a cancelled order and an unpaid one count for nothing.
  await addOrder(chitra, 60, 90000);
  await addOrder(dev, 1, 40000);
  await addOrder(esha, 3, 99900, 'cancelled');
  await addOrder(esha, 1, 99900, 'awaiting_payment');

  const { status, body } = await admin('GET', '/admin/dashboard?days=30');
  assert.equal(status, 200);
  // Gaps in the period: Asha 30 and 6 days, Ben 3 days; the middle value is 6.
  assert.deepEqual(body.customers, {
    customers: 3,
    new: 2,
    returning: 1,
    newRevenue: 120000,
    returningRevenue: 50000,
    orderedAgain: 2,
    daysBetween: 6,
    allTime: { customers: 4, repeat: 2 },
  });
  assert.equal(body.customers.newRevenue + body.customers.returningRevenue, body.totals.revenue);

  // Over 90 days every first order is in the period, so all four are new; Asha's 30-day gap now counts too.
  const quarter = (await admin('GET', '/admin/dashboard?days=90')).body.customers;
  assert.equal(quarter.new, 4);
  assert.equal(quarter.returning, 0);
  assert.equal(quarter.daysBetween, 6);
});

test('with no sales in the period, nothing but the all-time figures', async () => {
  await t.db.collection('orders').deleteMany({});
  await addOrder(new ObjectId(), 50, 10000);
  const { body } = await admin('GET', '/admin/dashboard?days=7');
  assert.equal(body.customers.customers, 0);
  assert.equal(body.customers.daysBetween, null);
  assert.deepEqual(body.customers.allTime, { customers: 1, repeat: 0 });
});
