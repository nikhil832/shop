import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { dispatchDelay, holidayState } from '../src/holiday.js';

const DAY = 86_400_000;
// The India-time day `n` days from now.
const day = (n) => new Date(Date.now() + 330 * 60_000 + n * DAY).toISOString().slice(0, 10);

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
beforeEach(() => t.db.collection('settings').deleteOne({ _id: 'holiday' }));

const setHoliday = (body) => admin('PUT', '/admin/holiday', { message: '', takeOrders: true, ...body });
async function order() {
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
  });
}

test('the shop sees a break from a week before until it ends', async () => {
  assert.deepEqual((await t.browser()('GET', '/holiday')).body, { holiday: null });
  const far = await setHoliday({ from: day(10), to: day(12), message: 'Happy Diwali!' });
  assert.equal(far.status, 200, JSON.stringify(far.body));
  assert.equal((await t.browser()('GET', '/holiday')).body.holiday, null); // more than a week away

  await setHoliday({ from: day(5), to: day(7), message: 'Happy Diwali!' });
  assert.deepEqual((await t.browser()('GET', '/holiday')).body.holiday, {
    from: day(5),
    to: day(7),
    message: 'Happy Diwali!',
    takeOrders: true,
    active: false,
    reopens: day(8),
  });
  await setHoliday({ from: day(-1), to: day(1) });
  assert.equal((await t.browser()('GET', '/holiday')).body.holiday.active, true);
});

test('admins only, with sensible dates; changes are logged', async () => {
  assert.equal((await customer('PUT', '/admin/holiday', { from: day(1), to: day(2), takeOrders: true })).status, 403);
  assert.equal((await t.browser()('GET', '/admin/holiday')).status, 401);
  const bad = async (body, pattern) => {
    const res = await setHoliday(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, pattern);
  };
  await bad({ from: day(3), to: day(1) }, /on or after its first day/);
  await bad({ from: day(1), to: day(61) }, /at most 60 days/);
  await bad({ from: '2026-02-30', to: day(1) }, /not in the calendar/);
  await bad({ from: day(-5), to: day(-1) }, /already ended/);
  await bad({ from: day(1), to: day(2), message: 'x'.repeat(161) }, /160 characters/);

  await setHoliday({ from: day(1), to: day(2) });
  assert.deepEqual((await admin('GET', '/admin/holiday')).body.holiday, {
    from: day(1),
    to: day(2),
    message: '',
    takeOrders: true,
  });
  assert.equal((await admin('DELETE', '/admin/holiday')).status, 204);
  assert.equal((await admin('GET', '/admin/holiday')).body.holiday, null);
  const log = await t.db.collection('activity').find({ area: 'delivery' }).sort({ at: 1 }).toArray();
  assert.deepEqual(
    log.slice(-2).map((e) => e.action),
    ['Set a store holiday', 'Ended the store holiday'],
  );
});

test('delivery dates during a break count from the day after it', async () => {
  // The default rule is 3–7 days. Away today and the next two days: dispatch starts in 3 days.
  await setHoliday({ from: day(0), to: day(2) });
  const check = await t.browser()('GET', '/delivery?pincode=560001');
  assert.equal(check.body.from, day(6));
  assert.equal(check.body.to, day(10));

  const placed = await order();
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  assert.deepEqual(placed.body.deliveryEstimate, { from: day(6), to: day(10) });

  // A break that hasn't started doesn't move anything.
  await t.db.collection('settings').deleteOne({ _id: 'holiday' });
  await setHoliday({ from: day(2), to: day(4) });
  assert.equal((await t.browser()('GET', '/delivery?pincode=560001')).body.from, day(3));
});

test('with orders paused, checkout is refused during the break and nothing is reserved', async () => {
  await setHoliday({ from: day(0), to: day(1), takeOrders: false });
  const book = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' });
  const res = await order();
  assert.equal(res.status, 409);
  assert.match(res.body.error, new RegExp(`aren't taking orders until ${day(2)}`));
  assert.equal((await t.db.collection('products').findOne({ _id: book._id })).stock, book.stock);

  // Before the break starts, orders still go through.
  await setHoliday({ from: day(1), to: day(2), takeOrders: false });
  assert.equal((await order()).status, 201);
});

test('the rules on their own', () => {
  const h = { from: '2026-11-10', to: '2026-11-12', message: '', takeOrders: true };
  const at = (d) => new Date(`${d}T06:00:00Z`); // midday India time
  assert.equal(dispatchDelay(h, at('2026-11-09')), 0);
  assert.equal(dispatchDelay(h, at('2026-11-10')), 3);
  assert.equal(dispatchDelay(h, at('2026-11-12')), 1);
  assert.equal(dispatchDelay(h, at('2026-11-13')), 0);
  assert.equal(holidayState(h, at('2026-11-02')), null);
  assert.equal(holidayState(h, at('2026-11-03')).active, false);
  assert.equal(holidayState(h, at('2026-11-13')), null);
  assert.equal(dispatchDelay(null), 0);
});
