import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { payReferrals } from '../src/referrals.js';
import { startTestServer } from './helpers.js';

let t;
let admin;
let asha;
let code;
before(async () => {
  t = await startTestServer();
  admin = await register('owner@example.com', 'Store Owner');
  await t.db.collection('users').updateOne({ email: 'owner@example.com' }, { $set: { role: 'admin' } });
  asha = await register('asha@example.com', 'Asha Rao');
});
after(() => t.stop());

async function register(email, name, ref) {
  const call = t.browser();
  const res = await call('POST', '/auth/register', { name, email, password: 'password123', ...(ref && { ref }) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  call.email = email;
  return call;
}

const DAY = 86_400_000;
const PHONE = 'orbit-a14-4gb-ram-64gb'; // ₹8,999
const BOOK = 'the-quiet-engineer-paperback'; // ₹349
const address = {
  name: 'Ravi Kumar',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};
const product = (slug) => t.db.collection('products').findOne({ slug });
async function quote(call, slug, extra = '') {
  const p = await product(slug);
  return (await call('GET', `/cart?items=${p._id}:1${extra}`)).body;
}
async function order(call, slug, couponCode) {
  const p = await product(slug);
  const q = await quote(call, slug, couponCode ? `&coupon=${couponCode}` : '');
  const res = await call('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty: 1 }],
    address,
    expectedTotal: q.total,
    ...(couponCode && { couponCode }),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
async function deliveredLongAgo(o) {
  for (const status of ['shipped', 'delivered']) await admin('POST', `/admin/orders/${o.id}/status`, { status });
  await t.db
    .collection('orders')
    .updateOne({ number: o.number }, { $set: { deliveredAt: new Date(Date.now() - 8 * DAY) } });
}

test('off until switched on; then each customer gets one lasting code', async () => {
  assert.deepEqual((await asha('GET', '/account/referral')).body, { enabled: false });
  const on = await admin('PUT', '/admin/referrals', {
    enabled: true,
    friendDiscount: 10000,
    minOrder: 50000,
    reward: 15000,
    monthlyCap: 2,
  });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  const mine = (await asha('GET', '/account/referral')).body;
  assert.match(mine.code, /^[A-Z2-9]{8}$/);
  assert.deepEqual([mine.friendDiscount, mine.reward, mine.joined], [10000, 15000, 0]);
  assert.equal((await asha('GET', '/account/referral')).body.code, mine.code);
  code = mine.code;
});

test("a referred friend's first order of ₹500+ gets the welcome; not a later one, nor with a coupon", async () => {
  const ravi = await register('ravi@example.com', 'Ravi Kumar', code);
  assert.equal((await asha('GET', '/account/referral')).body.joined, 1);
  assert.equal((await quote(ravi, BOOK)).referral, null); // ₹349: under ₹500
  const q = await quote(ravi, PHONE);
  assert.deepEqual(q.referral, { discount: 10000 });
  assert.equal(q.total, 899900 - 10000);

  const first = await order(ravi, PHONE);
  assert.equal(first.discount, 10000);
  assert.equal(first.referral, true);
  const mail = t.mail.sent.findLast((m) => m.to.email === 'ravi@example.com');
  assert.match(mail.text, /Friend's welcome: −₹100/);
  assert.equal((await quote(ravi, PHONE)).referral, null); // not the first any more

  // A coupon is used instead of the welcome.
  assert.equal((await admin('POST', '/admin/coupons', { code: 'FLAT50', type: 'flat', value: 5000 })).status, 201);
  const meera = await register('meera@example.com', 'Meera', code);
  const withCoupon = await quote(meera, PHONE, '&coupon=FLAT50');
  assert.deepEqual([withCoupon.discount, withCoupon.referral], [5000, null]);
  // An unknown code is ignored.
  const kiran = await register('kiran@example.com', 'Kiran', 'NOTACODE');
  assert.equal((await quote(kiran, PHONE)).referral, null);
});

test('a visitor arriving with a code sees the welcome, and checking out makes them a referred customer', async () => {
  const visitor = t.browser();
  const p = await product(PHONE);
  assert.deepEqual((await visitor('GET', `/cart?items=${p._id}:1&ref=${code}`)).body.referral, { discount: 10000 });
  await t.db.collection('rateLimits').deleteMany({});
  const made = await visitor('POST', '/auth/quick-account', { name: 'Neha', email: 'neha@example.com', ref: code });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const placed = await order(visitor, PHONE);
  assert.equal(placed.discount, 10000);
});

test('the referrer is rewarded once the order is kept past the return window; at most the monthly cap', async () => {
  const before = (await asha('GET', '/auth/me')).body.user.credit;
  const ravisOrder = await t.db
    .collection('orders')
    .findOne({ 'address.name': 'Ravi Kumar', referral: { $exists: true } });
  await deliveredLongAgo({ id: ravisOrder._id.toString(), number: ravisOrder.number });
  assert.equal(await payReferrals(t.ctx), 1);
  assert.equal(await payReferrals(t.ctx), 0); // once
  assert.equal((await asha('GET', '/auth/me')).body.user.credit, before + 15000);
  const mail = t.mail.sent.findLast((m) => m.to.email === 'asha@example.com');
  assert.equal(mail.subject, '₹150 for referring a friend');
  const mine = (await asha('GET', '/account/referral')).body;
  assert.deepEqual([mine.rewarded, mine.earned], [1, 15000]);

  // Neha's order makes the second this month; a third friend's would be over the cap of 2.
  const neha = await t.db
    .collection('orders')
    .findOne({ referral: { $exists: true }, 'referral.rewardedAt': { $exists: false } });
  await deliveredLongAgo({ id: neha._id.toString(), number: neha.number });
  assert.equal(await payReferrals(t.ctx), 1);
  const third = await register('third@example.com', 'Third', code);
  const thirdOrder = await order(third, PHONE);
  await deliveredLongAgo(thirdOrder);
  assert.equal(await payReferrals(t.ctx), 0);
  assert.equal((await t.db.collection('orders').findOne({ number: thirdOrder.number })).referral.reward, 0);
});

test('nothing for a friend who sent everything back; settings checked, admins only', async () => {
  await admin('PUT', '/admin/referrals', {
    enabled: true,
    friendDiscount: 10000,
    minOrder: 50000,
    reward: 15000,
    monthlyCap: 10,
  });
  const friend = await register('returns@example.com', 'Ret', code);
  const o = await order(friend, PHONE);
  for (const status of ['shipped', 'delivered']) await admin('POST', `/admin/orders/${o.id}/status`, { status });
  const ret = await friend('POST', `/orders/${o.id}/returns`, { items: [{ index: 0, qty: 1 }], reason: 'damaged' });
  await admin('POST', `/admin/returns/${ret.body.id}/approve`);
  await t.db
    .collection('orders')
    .updateOne({ number: o.number }, { $set: { deliveredAt: new Date(Date.now() - 8 * DAY) } });
  await payReferrals(t.ctx);
  assert.equal((await t.db.collection('orders').findOne({ number: o.number })).referral.reward, 0);

  assert.equal(
    (
      await admin('PUT', '/admin/referrals', {
        enabled: true,
        friendDiscount: 50,
        minOrder: 0,
        reward: 100,
        monthlyCap: 1,
      })
    ).status,
    400,
  );
  assert.equal((await asha('GET', '/admin/referrals')).status, 403);
  const page = (await admin('GET', '/admin/referrals')).body;
  assert.ok(page.joined >= 5);
  assert.equal(page.paid.rewards, 2);
});
