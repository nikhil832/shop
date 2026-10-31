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
// An order stored directly, so places, dates and amounts are exact.
async function addOrder({ city, state, total, daysAgo = 0, status = 'placed' }) {
  const createdAt = new Date(Date.now() - daysAgo * DAY);
  await t.db.collection('orders').insertOne({
    userId: new ObjectId(),
    items: [],
    subtotal: total,
    delivery: 0,
    discount: 0,
    total,
    status,
    payment: { method: 'cod' },
    address: { name: 'A', phone: '9876543210', line1: '1 Road', city, state, pincode: '560001' },
    createdAt,
    updatedAt: createdAt,
  });
}

test('the dashboard sums sales by state and by city', async () => {
  await addOrder({ city: 'Bengaluru', state: 'Karnataka', total: 100000 });
  await addOrder({ city: ' bengaluru ', state: 'Karnataka', total: 50000, status: 'delivered' });
  await addOrder({ city: 'Mysuru', state: 'Karnataka', total: 20000, status: 'shipped' });
  await addOrder({ city: 'Pune', state: 'Maharashtra', total: 120000 });
  await addOrder({ city: 'Hyderabad', state: 'Telangana', total: 30000, daysAgo: 2 });
  // Not this period's sales: cancelled, unpaid, or older.
  await addOrder({ city: 'Chennai', state: 'Tamil Nadu', total: 90000, status: 'cancelled' });
  await addOrder({ city: 'Chennai', state: 'Tamil Nadu', total: 90000, status: 'awaiting_payment' });
  await addOrder({ city: 'Kochi', state: 'Kerala', total: 90000, daysAgo: 10 });

  const { status, body } = await admin('GET', '/admin/dashboard?days=7');
  assert.equal(status, 200);
  assert.deepEqual(body.places.states, [
    { state: 'Karnataka', orders: 3, revenue: 170000 },
    { state: 'Maharashtra', orders: 1, revenue: 120000 },
    { state: 'Telangana', orders: 1, revenue: 30000 },
  ]);
  // Cities are grouped ignoring case and spaces, keeping the first spelling.
  assert.deepEqual(body.places.cities, [
    { city: 'Bengaluru', state: 'Karnataka', orders: 2, revenue: 150000 },
    { city: 'Pune', state: 'Maharashtra', orders: 1, revenue: 120000 },
    { city: 'Hyderabad', state: 'Telangana', orders: 1, revenue: 30000 },
    { city: 'Mysuru', state: 'Karnataka', orders: 1, revenue: 20000 },
  ]);
  assert.equal(
    body.places.states.reduce((n, s) => n + s.revenue, 0),
    body.totals.revenue,
  );

  // The 30 days take in the older order too.
  const month = (await admin('GET', '/admin/dashboard?days=30')).body;
  assert.deepEqual(
    month.places.states.map((r) => r.state),
    ['Karnataka', 'Maharashtra', 'Kerala', 'Telangana'],
  );
});

test('at most ten cities are listed', async () => {
  await t.db.collection('orders').deleteMany({});
  for (let i = 1; i <= 12; i++) await addOrder({ city: `Town ${i}`, state: 'Karnataka', total: i * 1000 });
  const { body } = await admin('GET', '/admin/dashboard?days=7');
  assert.equal(body.places.cities.length, 10);
  assert.equal(body.places.cities[0].city, 'Town 12');
  assert.deepEqual(body.places.states, [{ state: 'Karnataka', orders: 12, revenue: 78000 }]);
});
