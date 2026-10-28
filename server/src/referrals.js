import { randomBytes } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { requireAdmin, requireUser } from './auth.js';
import { parse } from './http.js';
import { logActivity, rupees } from './activity.js';
import { addCredit } from './credit.js';
import { referralRewardEmail } from './emails.js';

// Refer a friend (stage 87). Each customer gets `users.referralCode` (made the first time they open the account
// page's section); `/?ref=<code>` is remembered by the friend's browser and sent when they make an account (sign-up or
// checkout), which sets `users.referredBy`. Their first order then gets FRIEND_DISCOUNT off (as the order's
// `discount`, with `referral` { by }; a coupon replaces it), and once that order is delivered, past its return window
// and not all returned, the referrer gets `reward` as store credit (payReferrals, the minute sweep; at most
// `monthlyCap` a month). `settings` { _id: 'referrals', enabled, friendDiscount, minOrder, reward, monthlyCap }: off
// until switched on.

export const DEFAULTS = { enabled: false, friendDiscount: 10000, minOrder: 50000, reward: 10000, monthlyCap: 10 };
// The same as RETURN_DAYS in routes/returns.js; not imported, as orders.js imports this module.
const RETURN_DAYS = 7;
const DAY = 86_400_000;
const SETTINGS = 'referrals';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE = /^[A-Z2-9]{8}$/;

export async function referralSettings(db) {
  return { ...DEFAULTS, ...(await db.collection('settings').findOne({ _id: SETTINGS })) };
}

// The account a referral code belongs to (its _id), or null.
export async function referrerFor(db, code) {
  if (!code || !CODE.test(code)) return null;
  const user = await db.collection('users').findOne({ referralCode: code }, { projection: { _id: 1 } });
  return user?._id ?? null;
}

// The friend's welcome off this order, in paise (0 when it doesn't apply): referral on, the account referred (or,
// for a visitor about to make one at checkout, a valid `ref` code), no earlier order that wasn't cancelled, and
// enough in the cart (`subtotal`, after bundle savings).
export async function friendDiscount(db, { user, ref, subtotal }) {
  const s = await referralSettings(db);
  if (!s.enabled || subtotal < s.minOrder) return 0;
  if (user) {
    if (!user.referredBy) return 0;
    const earlier = await db.collection('orders').countDocuments({ userId: user._id, status: { $ne: 'cancelled' } });
    if (earlier) return 0;
  } else if (!(await referrerFor(db, ref))) {
    return 0;
  }
  return Math.min(s.friendDiscount, subtotal);
}

// Run every minute: rewards referrers for friends' first orders kept past the return window. Returns how many.
export async function payReferrals(ctx, now = new Date()) {
  const { db, client } = ctx;
  const s = await referralSettings(db);
  const orders = db.collection('orders');
  const due = await orders
    .find({
      status: 'delivered',
      'referral.by': { $exists: true },
      'referral.rewardedAt': { $exists: false },
      deliveredAt: { $lte: new Date(now.getTime() - RETURN_DAYS * DAY) },
    })
    .limit(50)
    .toArray();
  let paid = 0;
  for (const order of due) {
    const returns = await db.collection('returns').find({ orderId: order._id }).toArray();
    if (returns.some((r) => r.status === 'requested')) continue; // wait for the decision
    const back = new Map();
    for (const r of returns.filter((x) => x.status !== 'declined')) {
      for (const i of r.items) back.set(i.index, (back.get(i.index) ?? 0) + i.qty);
    }
    const kept = order.items.some((item, index) => item.qty > (back.get(index) ?? 0));
    const referrer = await db
      .collection('users')
      .findOne({ _id: order.referral.by }, { projection: { name: 1, email: 1 } });
    const monthStart = new Date(now.getTime() - 30 * DAY);
    const thisMonth = await db
      .collection('creditLedger')
      .countDocuments({ userId: order.referral.by, reason: 'referral', at: { $gte: monthStart } });
    // Off since, nothing kept, account gone or this month's rewards used up: recorded as not rewarded.
    const amount = s.enabled && kept && referrer && thisMonth < s.monthlyCap ? s.reward : 0;
    const session = client.startSession();
    let balance = null;
    try {
      await session.withTransaction(async () => {
        const claimed = await orders.updateOne(
          { _id: order._id, 'referral.rewardedAt': { $exists: false } },
          { $set: { 'referral.rewardedAt': now, 'referral.reward': amount } },
          { session },
        );
        if (!claimed.modifiedCount || !amount) return;
        balance = await addCredit(
          db,
          order.referral.by,
          amount,
          { reason: 'referral', note: 'A friend you referred made their first order' },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    if (balance === null) continue;
    paid += 1;
    try {
      await ctx.mail.send({
        to: { email: referrer.email, name: referrer.name },
        ...referralRewardEmail(referrer, amount, balance, ctx.config.mail?.publicUrl),
      });
    } catch (err) {
      console.error(`Could not email the referral reward for order ${order._id}:`, err.message);
    }
  }
  return paid;
}

const money = (min, max, label) =>
  z
    .number()
    .int()
    .min(min, label)
    .max(max)
    .refine((n) => n % 100 === 0, 'Whole rupees');
const settingsBody = z.object({
  enabled: z.boolean(),
  friendDiscount: money(100, 500_000, "The friend's discount: from ₹1"),
  minOrder: money(0, 10_000_000, 'From ₹0'),
  reward: money(100, 500_000, 'The reward: from ₹1'),
  monthlyCap: z.number().int().min(1, 'From 1').max(100, 'At most 100'),
});

export function referralsRouter({ db }) {
  const users = db.collection('users');
  const router = express.Router();

  // The customer's own link and how it's going; the code is made the first time.
  router.get('/account/referral', requireUser, async (req, res) => {
    const s = await referralSettings(db);
    if (!s.enabled) return res.json({ enabled: false });
    let code = req.user.referralCode;
    for (let tries = 0; !code && tries < 5; tries++) {
      const candidate = [...randomBytes(8)].map((b) => ALPHABET[b % 32]).join('');
      try {
        const done = await users.updateOne(
          { _id: req.user._id, referralCode: { $exists: false } },
          { $set: { referralCode: candidate } },
        );
        code = done.modifiedCount ? candidate : (await users.findOne({ _id: req.user._id })).referralCode;
      } catch (err) {
        if (err.code !== 11000) throw err; // the same code as someone else's: try another
      }
    }
    const [joined, rewards] = await Promise.all([
      users.countDocuments({ referredBy: req.user._id }),
      db
        .collection('creditLedger')
        .aggregate([
          { $match: { userId: req.user._id, reason: 'referral' } },
          { $group: { _id: null, total: { $sum: '$change' }, n: { $sum: 1 } } },
        ])
        .toArray(),
    ]);
    res.json({
      enabled: true,
      code,
      friendDiscount: s.friendDiscount,
      minOrder: s.minOrder,
      reward: s.reward,
      joined,
      rewarded: rewards[0]?.n ?? 0,
      earned: rewards[0]?.total ?? 0,
    });
  });

  router.use('/admin/referrals', requireAdmin);

  router.get('/admin/referrals', async (req, res) => {
    const s = await referralSettings(db);
    const [joined, paid] = await Promise.all([
      users.countDocuments({ referredBy: { $exists: true } }),
      db
        .collection('creditLedger')
        .aggregate([
          { $match: { reason: 'referral' } },
          { $group: { _id: null, total: { $sum: '$change' }, n: { $sum: 1 } } },
        ])
        .toArray(),
    ]);
    res.json({
      enabled: s.enabled,
      friendDiscount: s.friendDiscount,
      minOrder: s.minOrder,
      reward: s.reward,
      monthlyCap: s.monthlyCap,
      joined,
      paid: { total: paid[0]?.total ?? 0, rewards: paid[0]?.n ?? 0 },
    });
  });

  router.put('/admin/referrals', async (req, res) => {
    const body = parse(settingsBody, req.body);
    const before = await referralSettings(db);
    await db.collection('settings').updateOne({ _id: SETTINGS }, { $set: body }, { upsert: true });
    const changes = [
      ['On', before.enabled ? 'yes' : 'no', body.enabled ? 'yes' : 'no'],
      ["Friend's discount", rupees(before.friendDiscount), rupees(body.friendDiscount)],
      ['On orders from', rupees(before.minOrder), rupees(body.minOrder)],
      ['Reward', rupees(before.reward), rupees(body.reward)],
      ['Rewards a month', String(before.monthlyCap), String(body.monthlyCap)],
    ]
      .filter(([, from, to]) => from !== to)
      .map(([field, from, to]) => ({ field, from, to }));
    if (changes.length) {
      await logActivity(db, req.user, {
        area: 'coupons',
        action: 'Changed referrals',
        target: { label: 'Refer a friend', path: '/admin/coupons' },
        changes,
      });
    }
    res.json(body);
  });

  return router;
}
