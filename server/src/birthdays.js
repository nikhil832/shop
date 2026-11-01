import express from 'express';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { requireAdmin, requireUser, toUser } from './auth.js';
import { logActivity } from './activity.js';
import { birthdayEmail } from './emails.js';
import { parse } from './http.js';

// Birthday treat (stage 141): customers may save a birthday (day and month, no year) on the account page
// (`users.birthday` { month, day }, `birthdaySetAt`). With `settings` { _id: 'birthday', enabled, amount, minOrder,
// validDays } on, the minute sweep (sendBirthdayTreats) gives each customer whose birthday it is (India time; 29
// February counts on the 28th in other years) a one-use flat coupon of their own: `coupons` with `kind: 'birthday'` and
// `forUserId` (couponDiscount refuses it for anyone else, as an unknown code), left out of the admin's coupon list.
// At most one a customer within REPEAT_DAYS, and only for a birthday saved SETTLE_DAYS before, so changing the date
// (or saving today's on a new account) earns nothing extra.
export const DEFAULTS = { enabled: false, amount: 10000, minOrder: 50000, validDays: 14 };
export const SETTLE_DAYS = 30;
export const REPEAT_DAYS = 330;
const SETTINGS = 'birthday';
const BATCH = 50;
const DAY = 86_400_000;
const IST_OFFSET = 330 * 60_000;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const wholeRupees = (what, max) =>
  z
    .number()
    .int()
    .min(0, `${what} can't be negative`)
    .max(max, `${what} is at most ₹${(max / 100).toLocaleString('en-IN')}`)
    .refine((v) => v % 100 === 0, `${what}: use whole rupees`);
const settingsBody = z.object({
  enabled: z.boolean(),
  amount: wholeRupees('The amount', 200000).refine((v) => v >= 100, 'The amount is at least ₹1'),
  minOrder: wholeRupees('The minimum order', 10000000),
  validDays: z.number().int().min(1, 'Valid for at least 1 day').max(60, 'Valid for at most 60 days'),
});
const birthdayBody = z.object({
  birthday: z
    .object({
      month: z.number().int().min(1, 'Choose a month').max(12, 'Choose a month'),
      day: z.number().int().min(1, 'Choose a day').max(31, 'Choose a day'),
    })
    .refine((b) => b.day <= DAYS_IN_MONTH[b.month - 1], "That month doesn't have that day")
    .nullable(),
});

export async function birthdaySettings(db) {
  const doc = await db.collection('settings').findOne({ _id: SETTINGS });
  return { ...DEFAULTS, ...doc };
}

const istDate = (now) => new Date(now.getTime() + IST_OFFSET);
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
// The birthdays that are today in India: [{ month, day }], plus 29 February on the 28th of a year without one.
export function birthdaysOn(now) {
  const d = istDate(now);
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const list = [{ month, day }];
  if (month === 2 && day === 28 && !isLeap(d.getUTCFullYear())) list.push({ month: 2, day: 29 });
  return list;
}
const newCode = () => `BDAY${Array.from({ length: 8 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join('')}`;

// Run every minute: the day's birthday coupons. Returns how many were sent.
export async function sendBirthdayTreats(ctx, now = new Date()) {
  const { db } = ctx;
  const s = await birthdaySettings(db);
  if (!s.enabled) return 0;
  const users = db.collection('users');
  const due = {
    role: 'user',
    $or: birthdaysOn(now).map((b) => ({ 'birthday.month': b.month, 'birthday.day': b.day })),
    birthdaySetAt: { $lte: new Date(now.getTime() - SETTLE_DAYS * DAY) },
    $nor: [{ 'birthdayTreat.at': { $gt: new Date(now.getTime() - REPEAT_DAYS * DAY) } }],
  };
  let sent = 0;
  for (const user of await users.find(due).limit(BATCH).toArray()) {
    // Claimed first (the same filter), so two sweeps give one coupon.
    const claimed = await users.updateOne({ _id: user._id, ...due }, { $set: { birthdayTreat: { at: now } } });
    if (!claimed.modifiedCount) continue;
    const coupon = {
      type: 'flat',
      value: s.amount,
      maxDiscount: null,
      minSubtotal: s.minOrder,
      expiresAt: new Date(now.getTime() + s.validDays * DAY),
      usageLimit: 1,
      usedCount: 0,
      active: true,
      kind: 'birthday',
      forUserId: user._id,
      createdAt: now,
    };
    let inserted = null;
    for (let tries = 0; !inserted && tries < 5; tries++) {
      try {
        const code = newCode();
        await db.collection('coupons').insertOne({ ...coupon, code });
        inserted = { ...coupon, code };
      } catch (err) {
        if (err.code !== 11000) throw err;
      }
    }
    try {
      if (!inserted) throw new Error('no free coupon code');
      await ctx.mail.send({
        to: { email: user.email, name: user.name },
        ...birthdayEmail(user, inserted, ctx.config.mail?.publicUrl),
      });
      await users.updateOne({ _id: user._id }, { $set: { 'birthdayTreat.code': inserted.code } });
      sent += 1;
    } catch (err) {
      // Not sent: the coupon goes and the claim is undone, so the next sweep tries again.
      console.error(`Could not send the birthday treat to ${user._id}:`, err.message);
      if (inserted) await db.collection('coupons').deleteOne({ code: inserted.code });
      await users.updateOne({ _id: user._id }, { $unset: { birthdayTreat: '' } });
    }
  }
  return sent;
}

export function birthdayRouter({ db }) {
  const router = express.Router();
  const users = db.collection('users');

  // The customer's own birthday; null removes it. A changed date waits SETTLE_DAYS before it earns a treat.
  router.put('/account/birthday', requireUser, async (req, res) => {
    const { birthday } = parse(birthdayBody, req.body);
    const same = birthday && req.user.birthday?.month === birthday.month && req.user.birthday?.day === birthday.day;
    const update = birthday
      ? { $set: { birthday, ...(!same && { birthdaySetAt: new Date() }) } }
      : { $unset: { birthday: '', birthdaySetAt: '' } };
    const after = await users.findOneAndUpdate({ _id: req.user._id }, update, { returnDocument: 'after' });
    res.json({ user: toUser(after) });
  });

  // Whether the store gives birthday treats, for the account page's wording.
  router.get('/birthday-treat', async (req, res) => {
    const s = await birthdaySettings(db);
    res.json(s.enabled ? { amount: s.amount, minOrder: s.minOrder, validDays: s.validDays } : null);
  });

  router.use('/admin/birthday', requireAdmin);

  router.get('/admin/birthday', async (req, res) => {
    const s = await birthdaySettings(db);
    const since = new Date(Date.now() - 365 * DAY);
    const [stats] = await db
      .collection('coupons')
      .aggregate([
        { $match: { kind: 'birthday', createdAt: { $gte: since } } },
        { $group: { _id: null, sent: { $sum: 1 }, used: { $sum: '$usedCount' } } },
      ])
      .toArray();
    res.json({
      enabled: s.enabled,
      amount: s.amount,
      minOrder: s.minOrder,
      validDays: s.validDays,
      withBirthday: await users.countDocuments({ role: 'user', birthday: { $exists: true } }),
      lastYear: { sent: stats?.sent ?? 0, used: stats?.used ?? 0 },
    });
  });

  router.put('/admin/birthday', async (req, res) => {
    const body = parse(settingsBody, req.body);
    const before = await birthdaySettings(db);
    await db.collection('settings').updateOne({ _id: SETTINGS }, { $set: body }, { upsert: true });
    const text = (s) =>
      s.enabled ? `₹${s.amount / 100} off orders from ₹${s.minOrder / 100}, for ${s.validDays} days` : 'off';
    if (text(before) !== text(body)) {
      await logActivity(db, req.user, {
        area: 'coupons',
        action: 'Changed the birthday treat',
        target: { label: 'Birthday treat', path: '/admin/coupons' },
        changes: [{ field: 'Birthday treat', from: text(before), to: text(body) }],
      });
    }
    res.json(body);
  });

  return router;
}
