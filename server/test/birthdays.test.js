import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { birthdaysOn, DEFAULTS, sendBirthdayTreats } from '../src/birthdays.js';

// Birthday treat (stage 141).
let t;
let admin;
let asha;
let ravi;
before(async () => {
  t = await startTestServer();
  admin = t.browser();
  await admin('POST', '/auth/register', { name: 'Store Admin', email: 'admin@example.com', password: 'password123' });
  await t.db.collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
  asha = t.browser();
  await asha('POST', '/auth/register', { name: 'Asha Rao', email: 'asha@example.com', password: 'password123' });
  ravi = t.browser();
  await ravi('POST', '/auth/register', { name: 'Ravi Kumar', email: 'ravi@example.com', password: 'password123' });
});
after(() => t.stop());
beforeEach(() => {
  t.mail.sent.length = 0;
});

const DAY = 86_400_000;
const at = (iso) => new Date(`${iso}+05:30`); // India time
const users = () => t.db.collection('users');
const ON = { enabled: true, amount: 10000, minOrder: 50000, validDays: 14 };
// Saved long enough ago to count.
const settle = (email) => users().updateOne({ email }, { $set: { birthdaySetAt: new Date(Date.now() - 400 * DAY) } });

test('birthdays are today in India; 29 February counts on the 28th in other years', () => {
  assert.deepEqual(birthdaysOn(at('2026-11-02T00:10')), [{ month: 11, day: 2 }]);
  assert.deepEqual(birthdaysOn(at('2027-02-28T09:00')), [
    { month: 2, day: 28 },
    { month: 2, day: 29 },
  ]);
  assert.deepEqual(birthdaysOn(at('2028-02-28T09:00')), [{ month: 2, day: 28 }]);
});

test('customers save, change and remove a birthday; it is checked', async () => {
  for (const bad of [
    { month: 2, day: 30 },
    { month: 13, day: 1 },
    { month: 4, day: 31 },
    { month: 1, day: 0 },
  ]) {
    assert.equal((await asha('PUT', '/account/birthday', { birthday: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await t.call('PUT', '/account/birthday', { birthday: { month: 1, day: 1 } })).status, 401);
  const res = await asha('PUT', '/account/birthday', { birthday: { month: 2, day: 29 } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.user.birthday, { month: 2, day: 29 });
  const setAt = (await users().findOne({ email: 'asha@example.com' })).birthdaySetAt;
  // Saving the same date again keeps when it was set; a new date restarts it.
  await asha('PUT', '/account/birthday', { birthday: { month: 2, day: 29 } });
  assert.deepEqual((await users().findOne({ email: 'asha@example.com' })).birthdaySetAt, setAt);
  await asha('PUT', '/account/birthday', { birthday: { month: 11, day: 2 } });
  assert.ok((await users().findOne({ email: 'asha@example.com' })).birthdaySetAt > setAt);
  assert.equal((await asha('GET', '/account/data')).body.account.birthday.month, 11);
  const removed = await ravi('PUT', '/account/birthday', { birthday: null });
  assert.equal(removed.body.user.birthday, null);
});

test('admins set the treat; checked and logged; the shop sees only whether it is on', async () => {
  assert.equal((await t.call('GET', '/birthday-treat')).body, null);
  assert.deepEqual(Object.keys((await admin('GET', '/admin/birthday')).body), [
    'enabled',
    'amount',
    'minOrder',
    'validDays',
    'withBirthday',
    'lastYear',
  ]);
  assert.equal((await asha('PUT', '/admin/birthday', ON)).status, 403);
  for (const bad of [
    { ...ON, amount: 0 },
    { ...ON, amount: 10050 },
    { ...ON, validDays: 0 },
    { ...ON, validDays: 61 },
  ]) {
    assert.equal((await admin('PUT', '/admin/birthday', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await admin('PUT', '/admin/birthday', ON)).status, 200);
  assert.deepEqual((await t.call('GET', '/birthday-treat')).body, { amount: 10000, minOrder: 50000, validDays: 14 });
  const log = await t.db.collection('activity').findOne({ action: 'Changed the birthday treat' });
  assert.deepEqual(log.changes, [
    { field: 'Birthday treat', from: 'off', to: '₹100 off orders from ₹500, for 14 days' },
  ]);
  assert.equal(DEFAULTS.enabled, false);
});

test("on the day: one coupon of the customer's own, once; not for a date saved lately", async () => {
  const day = at('2026-11-02T09:00');
  // Asha's 2 November was just saved: it waits 30 days.
  assert.equal(await sendBirthdayTreats(t.ctx, day), 0);
  await settle('asha@example.com');
  assert.equal(await sendBirthdayTreats(t.ctx, at('2026-11-01T23:00')), 0); // the day before
  assert.equal(await sendBirthdayTreats(t.ctx, day), 1);
  assert.equal(await sendBirthdayTreats(t.ctx, at('2026-11-02T20:00')), 0); // once

  const mail = t.mail.sent[0];
  assert.equal(mail.to.email, 'asha@example.com');
  assert.equal(mail.subject, 'Happy birthday, Asha! ₹100 off from us');
  const user = await users().findOne({ email: 'asha@example.com' });
  const code = user.birthdayTreat.code;
  assert.match(code, /^BDAY[A-Z2-9]{8}$/);
  assert.match(mail.text, new RegExp(`Use the code ${code} at checkout by 16 November`));
  const coupon = await t.db.collection('coupons').findOne({ code });
  assert.equal(coupon.kind, 'birthday');
  assert.equal(coupon.usageLimit, 1);
  // Not in the admin's coupon list; counted on the birthday form.
  assert.ok(!(await admin('GET', '/admin/coupons')).body.some((c) => c.code === code));

  // Only Asha can use it (others see an unknown code), from ₹500 of items.
  const book = await t.db.collection('products').findOne({ slug: 'the-quiet-engineer-paperback' }); // ₹349
  const mixer = await t.db.collection('products').findOne({ price: { $gte: 50000 }, stock: { $gt: 5 } });
  const quote = (who, id) => who('GET', `/cart?items=${id}:1&coupon=${code}`);
  assert.equal((await quote(ravi, mixer._id)).body.couponError, "This coupon code isn't valid");
  assert.equal((await quote(t.call, mixer._id)).body.couponError, "This coupon code isn't valid");
  assert.match((await quote(asha, book._id)).body.couponError, /more to use this coupon/);
  const mine = (await quote(asha, mixer._id)).body;
  assert.equal(mine.couponError, null);
  assert.equal(mine.discount, 10000);

  // Next year it comes again; a send that fails is tried again by the next sweep.
  const nextYear = at('2027-11-02T09:00');
  t.mail.failNext();
  assert.equal(await sendBirthdayTreats(t.ctx, nextYear), 0);
  assert.equal(await t.db.collection('coupons').countDocuments({ kind: 'birthday' }), 1);
  assert.equal(await sendBirthdayTreats(t.ctx, nextYear), 1);
  assert.equal(await t.db.collection('coupons').countDocuments({ kind: 'birthday' }), 2);

  // Off: nothing.
  await admin('PUT', '/admin/birthday', { ...ON, enabled: false });
  await users().updateOne({ email: 'asha@example.com' }, { $unset: { birthdayTreat: '' } });
  assert.equal(await sendBirthdayTreats(t.ctx, day), 0);
});
