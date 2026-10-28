import express from 'express';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { parse } from './http.js';
import { logActivity, rupees } from './activity.js';
import { addCredit } from './credit.js';
import { cashbackEmail } from './emails.js';

// Cashback (stage 85): a percentage of what a delivered order paid for the items kept comes back as store credit once
// its return window has passed. `settings` { _id: 'cashback', enabled, percent, cap (paise per order), since }: off
// until an admin switches it on, and only orders placed from then (`since`, set when switched on) earn it, so
// switching on never pays for old orders. The minute sweep (payCashback) gives each due order `cashback` { amount, at }
// and the credit in one transaction, so it's paid once. Nothing is paid while a return of the order awaits a decision.

export const DEFAULTS = { enabled: false, percent: 2, cap: 20000 };
// The same as RETURN_DAYS in routes/returns.js and the lists in routes/dashboard.js; not imported, as orders.js imports
// this module and both of those lead back to it.
const RETURN_DAYS = 7;
const REFUNDED_RETURNS = ['approved', 'refunding', 'refunded', 'refund_failed'];
const DAY = 86_400_000;
const SETTINGS = 'cashback';

export async function cashbackSettings(db) {
  const doc = await db.collection('settings').findOne({ _id: SETTINGS });
  return { ...DEFAULTS, since: null, ...doc };
}

// The cashback on `base` paise (what was paid for the items kept): the percentage, down to whole rupees, at most the cap.
export const cashbackOn = (base, { percent, cap }) =>
  Math.min(cap, Math.floor((Math.max(0, base) * percent) / 100 / 100) * 100);

// What an order paid for its items: their prices less its coupon's discount (not a free-delivery one), no delivery.
const itemsPaid = (order) => order.subtotal - (order.coupon?.type === 'free_delivery' ? 0 : (order.discount ?? 0));

// Run every minute: pays the cashback of delivered orders whose return window has passed. Returns how many it paid.
export async function payCashback(ctx, now = new Date()) {
  const { db, client } = ctx;
  const settings = await cashbackSettings(db);
  if (!settings.enabled || !settings.since) return 0;
  const orders = db.collection('orders');
  const due = await orders
    .find({
      status: 'delivered',
      deliveredAt: { $lte: new Date(now.getTime() - RETURN_DAYS * DAY) },
      createdAt: { $gte: settings.since },
      cashback: { $exists: false },
    })
    .limit(50)
    .toArray();
  let paid = 0;
  for (const order of due) {
    const returns = await db.collection('returns').find({ orderId: order._id }).toArray();
    // A return still waiting for a decision could change what was kept: wait for it.
    if (returns.some((r) => r.status === 'requested')) continue;
    const refunded = returns.filter((r) => REFUNDED_RETURNS.includes(r.status)).reduce((s, r) => s + r.refund, 0);
    const amount = cashbackOn(itemsPaid(order) - refunded, settings);
    const user = await db.collection('users').findOne({ _id: order.userId }, { projection: { name: 1, email: 1 } });
    const session = client.startSession();
    let balance = null;
    try {
      await session.withTransaction(async () => {
        // Claimed in the transaction: two sweeps at once can't both pay it.
        const claimed = await orders.updateOne(
          { _id: order._id, cashback: { $exists: false } },
          { $set: { cashback: { amount: user ? amount : 0, percent: settings.percent, at: now } } },
          { session },
        );
        if (!claimed.modifiedCount || !user || !amount) return;
        balance = await addCredit(
          db,
          order.userId,
          amount,
          { reason: 'cashback', orderId: order._id, orderNumber: order.number ?? null },
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
        to: { email: user.email, name: user.name },
        ...cashbackEmail(user, order, amount, balance, ctx.config.mail?.publicUrl),
      });
    } catch (err) {
      console.error(`Could not email the cashback for order ${order._id}:`, err.message);
    }
  }
  return paid;
}

const settingsBody = z.object({
  enabled: z.boolean(),
  percent: z.number().int().min(1, 'From 1%').max(20, 'At most 20%'),
  cap: z
    .number()
    .int()
    .min(100, 'From ₹1')
    .max(1_000_000, 'At most ₹10,000')
    .refine((n) => n % 100 === 0, 'Whole rupees'),
});

export function cashbackRouter({ db }) {
  const router = express.Router();
  router.use('/admin/cashback', requireAdmin);

  router.get('/admin/cashback', async (req, res) => {
    const s = await cashbackSettings(db);
    const paid = await db
      .collection('creditLedger')
      .aggregate([
        { $match: { reason: 'cashback' } },
        { $group: { _id: null, total: { $sum: '$change' }, n: { $sum: 1 } } },
      ])
      .toArray();
    res.json({
      enabled: s.enabled,
      percent: s.percent,
      cap: s.cap,
      since: s.since,
      paid: { total: paid[0]?.total ?? 0, orders: paid[0]?.n ?? 0 },
    });
  });

  router.put('/admin/cashback', async (req, res) => {
    const body = parse(settingsBody, req.body);
    const before = await cashbackSettings(db);
    // Switching on starts the clock: only orders placed from now earn cashback.
    const since = body.enabled && !before.enabled ? new Date() : before.since;
    await db.collection('settings').updateOne({ _id: SETTINGS }, { $set: { ...body, since } }, { upsert: true });
    const changes = [
      ['On', before.enabled ? 'yes' : 'no', body.enabled ? 'yes' : 'no'],
      ['Percent', `${before.percent}%`, `${body.percent}%`],
      ['Up to', rupees(before.cap), rupees(body.cap)],
    ]
      .filter(([, from, to]) => from !== to)
      .map(([field, from, to]) => ({ field, from, to }));
    if (changes.length) {
      await logActivity(db, req.user, {
        area: 'coupons',
        action: 'Changed cashback',
        target: { label: 'Cashback', path: '/admin/coupons' },
        changes,
      });
    }
    res.json({ ...body, since });
  });

  return router;
}
