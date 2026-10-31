import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
let asha;
let ashaId;
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  asha = t.browser();
  await asha('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
  ashaId = (await t.db.collection('users').findOne({ email: 'asha@example.com' }))._id;
});
after(() => t.stop());

const DAY = 86_400_000;
const LEVELS = {
  enabled: true,
  silver: { spend: 500000, freeDeliveryMin: 29900 },
  gold: { spend: 2000000, freeDeliveryMin: 0 },
};
// A delivered order of `total` paise for Asha, `daysAgo` days ago.
async function delivered(total, daysAgo = 10) {
  const at = new Date(Date.now() - daysAgo * DAY);
  const { insertedId } = await t.db.collection('orders').insertOne({
    userId: ashaId,
    items: [],
    subtotal: total,
    delivery: 0,
    discount: 0,
    total,
    status: 'delivered',
    payment: { method: 'cod' },
    createdAt: at,
    deliveredAt: at,
  });
  return insertedId;
}
const book = () => t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' }); // ₹349
const quote = async () => (await asha('GET', `/cart?items=${(await book())._id}:1`)).body;

test('off by default: the usual free-delivery minimum, and no level on the account page', async () => {
  const q = await quote();
  assert.equal(q.freeDeliveryMin, 49900);
  assert.equal(q.delivery, 4000);
  assert.equal(q.loyalty, null);
  assert.deepEqual((await asha('GET', '/account/loyalty')).body, { loyalty: null, levels: null });
});

test('admins set the levels; the settings are checked and logged', async () => {
  const bad = async (body, pattern) => {
    const res = await admin('PUT', '/admin/loyalty', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, pattern);
  };
  await bad({ ...LEVELS, gold: { ...LEVELS.gold, spend: 500000 } }, /Gold must need more/);
  await bad({ ...LEVELS, silver: { ...LEVELS.silver, freeDeliveryMin: 59900 } }, /above the usual ₹499/);
  await bad({ ...LEVELS, gold: { ...LEVELS.gold, freeDeliveryMin: 39900 } }, /no higher than Silver's/);
  await bad({ ...LEVELS, silver: { ...LEVELS.silver, spend: 500050 } }, /whole rupees/);
  assert.equal((await asha('PUT', '/admin/loyalty', LEVELS)).status, 403);

  const res = await admin('PUT', '/admin/loyalty', LEVELS);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const got = (await admin('GET', '/admin/loyalty')).body;
  assert.equal(got.enabled, true);
  assert.equal(got.usualFreeDeliveryMin, 49900);
  const log = await t.db.collection('activity').findOne({ action: 'Changed loyalty levels' });
  assert.deepEqual(
    log.changes.map((c) => c.field),
    ['On'],
  );
});

test('Silver lowers the free-delivery minimum, in the quote and the order', async () => {
  const none = (await asha('GET', '/account/loyalty')).body.loyalty;
  assert.equal(none.level, null);
  assert.deepEqual(none.next, { level: 'silver', label: 'Silver', needed: 500000, freeDeliveryMin: 29900 });

  await delivered(300000);
  await delivered(250000);
  await delivered(900000, 400); // more than a year ago: doesn't count
  const mine = (await asha('GET', '/account/loyalty')).body.loyalty;
  assert.equal(mine.level, 'silver');
  assert.equal(mine.spent, 550000);
  assert.equal(mine.next.needed, 1450000);

  const q = await quote();
  assert.equal(q.freeDeliveryMin, 29900);
  assert.equal(q.delivery, 0);
  assert.deepEqual(q.loyalty, { level: 'silver', label: 'Silver', freeDeliveryMin: 29900 });
  const b = await book();
  const placed = await asha('POST', '/orders', {
    items: [{ productId: b._id.toString(), qty: 1 }],
    address: {
      name: 'Asha Rao',
      phone: '9876543210',
      line1: '12 MG Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
    },
    expectedTotal: q.total,
  });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  assert.equal(placed.body.delivery, 0);
  // Visitors and other customers still pay the usual delivery.
  assert.equal((await t.call('GET', `/cart?items=${b._id}:1`)).body.delivery, 4000);
});

test('refunds count against the spend; Gold makes every delivery free', async () => {
  const order = await delivered(60000);
  await t.db.collection('returns').insertOne({ orderId: order, refund: 200000, status: 'refunded', items: [] });
  // 550000 + 60000 − 200000 = 410000: below Silver again.
  assert.equal((await asha('GET', '/account/loyalty')).body.loyalty.level, null);
  assert.equal((await quote()).delivery, 4000);

  await delivered(2000000);
  const gold = (await asha('GET', '/account/loyalty')).body.loyalty;
  assert.equal(gold.level, 'gold');
  assert.equal(gold.next, null);
  assert.equal((await quote()).delivery, 0);
  assert.equal((await quote()).freeDeliveryMin, 0);

  // Switched off: back to the usual rule.
  await admin('PUT', '/admin/loyalty', { ...LEVELS, enabled: false });
  assert.equal((await quote()).delivery, 4000);
});
