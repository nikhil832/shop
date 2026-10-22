import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t;
let admin;
before(async () => {
  t = await startTestServer({ razorpay: true });
  admin = await register();
  await t.db.collection('users').updateOne({ email: admin.email }, { $set: { role: 'admin' } });
});
after(() => t.stop());

let n = 0;
async function register() {
  const email = `coupon${++n}@example.com`;
  const call = t.browser();
  assert.equal(
    (await call('POST', '/auth/register', { name: 'Asha Rao', email, password: 'password123' })).status,
    201,
  );
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
const PHONE = 'orbit-a14-4gb-ram-64gb'; // ₹8,999, stock 40
const BOOK = 'the-quiet-engineer-paperback'; // ₹349: below free delivery, so ₹40 delivery
const product = (slug) => t.db.collection('products').findOne({ slug });

async function createCoupon(body) {
  const res = await admin('POST', '/admin/coupons', body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
async function quote(call, slug, qty, coupon) {
  const p = await product(slug);
  return (await call('GET', `/cart?items=${p._id}:${qty}${coupon ? `&coupon=${encodeURIComponent(coupon)}` : ''}`))
    .body;
}
async function order(call, slug, qty, couponCode, expectedTotal, paymentMethod = 'cod') {
  const p = await product(slug);
  return call('POST', '/orders', {
    items: [{ productId: p._id.toString(), qty }],
    address,
    expectedTotal,
    couponCode,
    paymentMethod,
  });
}

test('admins create coupons with checked rules; customers cannot', async () => {
  const customer = await register();
  assert.equal((await customer('GET', '/admin/coupons')).status, 403);
  assert.equal((await t.call('POST', '/admin/coupons', {})).status, 401);

  const c = await createCoupon({
    code: ' save10 ',
    type: 'percent',
    value: 10,
    maxDiscount: 50000,
    minSubtotal: 100000,
  });
  assert.equal(c.code, 'SAVE10');
  assert.equal(c.usedCount, 0);
  assert.equal(c.active, true);

  const bad = async (body) => (await admin('POST', '/admin/coupons', body)).body.error;
  assert.equal(await bad({ code: 'SAVE10', type: 'flat', value: 5000 }), 'A coupon with this code already exists');
  assert.equal(await bad({ code: 'NO', type: 'flat', value: 5000 }), 'code: Use 3–20 letters and digits');
  assert.equal(await bad({ code: 'HALF', type: 'percent', value: 95 }), 'value: Enter a percentage from 1 to 90');
  assert.equal(await bad({ code: 'TINY', type: 'flat', value: 50 }), 'value: Enter an amount of at least ₹1');
  assert.equal(await bad({ code: 'PAISE', type: 'flat', value: 9950 }), 'value: Enter whole rupees');
  assert.equal(
    await bad({ code: 'CAPPED', type: 'flat', value: 5000, maxDiscount: 10000 }),
    'maxDiscount: Only percentage coupons have a maximum',
  );

  const off = await admin('PATCH', `/admin/coupons/${c.id}`, { active: false });
  assert.equal(off.body.active, false);
  assert.ok((await admin('GET', '/admin/coupons')).body.some((x) => x.code === 'SAVE10' && !x.active));
});

test('the cart quote applies a coupon, or says why it cannot', async () => {
  await createCoupon({ code: 'TENOFF', type: 'percent', value: 10, maxDiscount: 200000 });
  await createCoupon({ code: 'FLAT200', type: 'flat', value: 20000, minSubtotal: 50000 });
  await createCoupon({ code: 'SHIPFREE', type: 'free_delivery' });
  await createCoupon({ code: 'OLD', type: 'flat', value: 10000, expiresAt: '2020-01-01T00:00:00Z' });
  const call = await register();

  // 10% of ₹17,998 is ₹1,799.80, rounded down to whole rupees.
  const pct = await quote(call, PHONE, 2, 'tenoff');
  assert.deepEqual(pct.coupon, { code: 'TENOFF', type: 'percent', discount: 179900 });
  assert.equal(pct.discount, 179900);
  assert.equal(pct.total, 1799800 - 179900);
  // The cap: 10% of ₹89,990 (10 phones) is more than ₹2,000.
  assert.equal((await quote(call, PHONE, 10, 'TENOFF')).discount, 200000);

  assert.equal((await quote(call, PHONE, 1, 'FLAT200')).total, 899900 - 20000);
  const short = await quote(call, BOOK, 1, 'FLAT200');
  assert.equal(short.couponError, 'Add ₹151 more to use this coupon');
  assert.equal(short.total, 34900 + 4000);

  const ship = await quote(call, BOOK, 1, 'SHIPFREE');
  assert.equal(ship.discount, 4000);
  assert.equal(ship.total, 34900);
  assert.equal((await quote(call, PHONE, 1, 'SHIPFREE')).couponError, 'Delivery is already free on this order');

  assert.equal((await quote(call, PHONE, 1, 'NOPE')).couponError, "This coupon code isn't valid");
  assert.equal((await quote(call, PHONE, 1, 'OLD')).couponError, 'This coupon has expired');
  assert.equal((await quote(t.call, PHONE, 1, 'TENOFF')).discount, 89900); // guests can see it too
  assert.equal((await quote(call, PHONE, 1)).discount, 0);
});

test('an order uses the coupon once per customer, and cancelling gives it back', async () => {
  const c = await createCoupon({ code: 'ONCE100', type: 'flat', value: 10000 });
  const call = await register();
  const stock = (await product(PHONE)).stock;

  // The expected total must include the discount, as the customer saw it.
  assert.equal((await order(call, PHONE, 1, 'ONCE100', 899900)).status, 409);
  const res = await order(call, PHONE, 1, 'once100', 889900);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.discount, 10000);
  assert.deepEqual(res.body.coupon, { code: 'ONCE100', type: 'flat' });
  assert.equal(res.body.total, 889900);
  const confirmation = t.mail.sent.findLast((m) => m.to.email === call.email);
  assert.match(confirmation.text, /Coupon ONCE100: −₹100/);

  // A second order with it is refused, and changes nothing.
  const again = await order(call, PHONE, 1, 'ONCE100', 889900);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "You've already used this coupon");
  assert.equal((await product(PHONE)).stock, stock - 1);
  assert.equal((await quote(call, PHONE, 1, 'ONCE100')).couponError, "You've already used this coupon");
  assert.equal((await admin('GET', '/admin/coupons')).body.find((x) => x.id === c.id).usedCount, 1);

  // Cancelling gives the use back.
  assert.equal((await call('POST', `/orders/${res.body.id}/cancel`)).status, 200);
  assert.equal((await admin('GET', '/admin/coupons')).body.find((x) => x.id === c.id).usedCount, 0);
  assert.equal((await order(call, PHONE, 1, 'ONCE100', 889900)).status, 201);
});

test('the usage limit holds, even for orders placed at the same moment', async () => {
  await createCoupon({ code: 'FIRST2', type: 'flat', value: 10000, usageLimit: 2 });
  const buyers = await Promise.all([register(), register(), register(), register()]);
  const results = await Promise.all(buyers.map((call) => order(call, PHONE, 1, 'FIRST2', 889900)));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 201, 409, 409]);
  assert.equal((await t.db.collection('coupons').findOne({ code: 'FIRST2' })).usedCount, 2);

  // One customer sending two orders at once also gets it only once.
  await createCoupon({ code: 'TWICE', type: 'flat', value: 10000 });
  const call = await register();
  const pair = await Promise.all([order(call, PHONE, 1, 'TWICE', 889900), order(call, PHONE, 1, 'TWICE', 889900)]);
  assert.deepEqual(pair.map((r) => r.status).sort(), [201, 409]);
});

test('an inactive coupon is refused, and online payment asks for the discounted total', async () => {
  const c = await createCoupon({ code: 'PAYLESS', type: 'percent', value: 20 });
  const call = await register();
  await admin('PATCH', `/admin/coupons/${c.id}`, { active: false });
  const refused = await order(call, PHONE, 1, 'PAYLESS', 720000);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "This coupon code isn't valid");

  await admin('PATCH', `/admin/coupons/${c.id}`, { active: true });
  const res = await order(call, PHONE, 1, 'PAYLESS', 720000, 'razorpay');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.checkout.amount, 720000);
  assert.equal(t.fake.state.orders.get(res.body.payment.razorpayOrderId).amount, 720000);
});
