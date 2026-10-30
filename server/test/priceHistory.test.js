import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { recordDailyPrices } from '../src/priceHistory.js';
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
const BOOK = 'the-quiet-engineer-paperback'; // ₹349
const product = (slug) => t.db.collection('products').findOne({ slug });
const istDay = (date) => new Date(date.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const today = () => istDay(new Date());
const daysOf = async (slug) =>
  t.db
    .collection('priceDays')
    .find({ productId: (await product(slug))._id })
    .sort({ day: 1 })
    .toArray();
// Earlier days of history for the book, at `low` each.
async function history(days, low) {
  const book = await product(BOOK);
  for (let i = 1; i <= days; i++) {
    await t.db
      .collection('priceDays')
      .updateOne(
        { productId: book._id, day: istDay(new Date(Date.now() - i * DAY)) },
        { $set: { low, expiresAt: new Date(Date.now() + DAY) } },
        { upsert: true },
      );
  }
}

test('once a day every shown product is recorded; a price change records the lower price at once', async () => {
  assert.equal(await recordDailyPrices(t.ctx), 'recorded');
  assert.equal(await recordDailyPrices(t.ctx), 'done'); // the same day
  assert.equal(await t.db.collection('priceDays').countDocuments({ day: today() }), 38);
  assert.deepEqual(
    (await daysOf(BOOK)).map((d) => d.low),
    [34900],
  );

  // An admin lowers the price: today's low follows; raising it again keeps the low.
  const book = await product(BOOK);
  await admin('PATCH', `/admin/products/${book._id}`, { price: 29900 });
  await admin('PATCH', `/admin/products/${book._id}`, { price: 34900 });
  assert.equal((await daysOf(BOOK)).at(-1).low, 29900);
});

test('a sale starting records its prices', async () => {
  const phone = await product('orbit-a14-4gb-ram-64gb');
  const res = await admin('POST', '/admin/sales', {
    name: 'Flash',
    percent: 10,
    productIds: [phone._id.toString()],
    startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + DAY).toISOString(),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const [day] = await daysOf('orbit-a14-4gb-ram-64gb');
  assert.equal(day.low, (await product('orbit-a14-4gb-ram-64gb')).price);
  assert.ok(day.low < phone.price);
});

test('the product page claims the lowest price only with a week of history, and only when true', async () => {
  // Today: ₹299 was the low (the edit above). Not enough history yet.
  assert.equal((await t.call('GET', `/products/${BOOK}`)).body.priceInsight, null);

  await history(10, 39900); // dearer before
  const book = await product(BOOK);
  await t.db.collection('products').updateOne({ _id: book._id }, { $set: { price: 29900 } });
  const lowest = (await t.call('GET', `/products/${BOOK}`)).body.priceInsight;
  assert.deepEqual(lowest, { days: 11, lowest: 29900, isLowest: true });

  // Back up to ₹349: ₹299 earlier today is the lowest.
  await t.db.collection('products').updateOne({ _id: book._id }, { $set: { price: 34900 } });
  assert.deepEqual((await t.call('GET', `/products/${BOOK}`)).body.priceInsight, {
    days: 11,
    lowest: 29900,
    isLowest: false,
  });
});
