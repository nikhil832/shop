import express from 'express';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { logActivity, rupees } from './activity.js';
import { addCredit } from './credit.js';
import { reviewRewardEmail } from './emails.js';
import { parse } from './http.js';

// Review rewards (stage 145): store credit for a helpful review. `settings` { _id: 'reviewRewards', enabled, amount
// (paise, whole rupees), minChars, monthlyCap, since }: off until an admin switches it on, and only reviews written from
// then (`since`) count, like cashback. The minute sweep (payReviewRewards) pays a review once it has at least one
// photo and minChars of written text (title and body together), has been shown for SETTLE_DAYS, and, when screening
// runs (ctx.ai), was screened and isn't a flag still waiting; at most `monthlyCap` rewards per customer in 30 days.
// Paid once per customer and product: `reviewRewards` { userId, productId, reviewId, amount, at } is unique per
// (userId, productId), so deleting a review and writing it again earns nothing more. A review hidden after it was
// paid keeps its reward.
export const DEFAULTS = { enabled: false, amount: 2000, minChars: 50, monthlyCap: 5 };
export const SETTLE_DAYS = 3;
const SETTINGS = 'reviewRewards';
const DAY = 86_400_000;
const BATCH = 50;

const settingsBody = z.object({
  enabled: z.boolean(),
  amount: z
    .number()
    .int()
    .min(100, 'amount: At least ₹1')
    .max(50000, 'amount: At most ₹500')
    .refine((v) => v % 100 === 0, 'amount: Use whole rupees'),
  minChars: z.number().int().min(0, 'minChars: 0 or more').max(1000, 'minChars: At most 1000'),
  monthlyCap: z.number().int().min(1, 'monthlyCap: At least 1').max(50, 'monthlyCap: At most 50'),
});

export async function reviewRewardSettings(db) {
  const doc = await db.collection('settings').findOne({ _id: SETTINGS });
  return { ...DEFAULTS, since: null, ...doc };
}

const writtenLength = (review) => `${review.title ?? ''} ${review.body ?? ''}`.trim().length;

// Run every minute: pays the reviews that have qualified. Returns how many were paid.
export async function payReviewRewards(ctx, now = new Date()) {
  const { db, client } = ctx;
  const s = await reviewRewardSettings(db);
  if (!s.enabled || !s.since) return 0;
  const reviews = db.collection('reviews');
  const due = await reviews
    .find({
      reward: { $exists: false },
      hidden: false,
      'photos.0': { $exists: true },
      createdAt: { $gte: s.since, $lte: new Date(now - SETTLE_DAYS * DAY) },
    })
    .sort({ createdAt: 1 })
    .limit(BATCH)
    .toArray();
  let paid = 0;
  for (const review of due) {
    // Not (yet) qualifying: too short, or waiting for screening. Looked at again next sweep, as an edit may change it.
    if (writtenLength(review) < s.minChars) continue;
    if (ctx.ai) {
      const version = review.updatedAt ?? review.createdAt;
      const screened = review.screening && !review.screening.failed && review.screening.of >= version;
      if (!screened) continue;
      if (review.screening.flagged && !review.screening.cleared) continue;
    }
    const recent = await db
      .collection('reviewRewards')
      .countDocuments({ userId: review.userId, at: { $gt: new Date(now - 30 * DAY) } });
    if (recent >= s.monthlyCap) continue;
    // Already rewarded for this product (an earlier review, since deleted): marked, unpaid.
    if (await db.collection('reviewRewards').findOne({ userId: review.userId, productId: review.productId })) {
      await reviews.updateOne(
        { _id: review._id, reward: { $exists: false } },
        { $set: { reward: { amount: 0, at: now } } },
      );
      continue;
    }
    const product = await db.collection('products').findOne({ _id: review.productId }, { projection: { title: 1 } });
    const session = client.startSession();
    let balance = null;
    try {
      await session.withTransaction(async () => {
        balance = null;
        // Claimed first (reward missing in the filter), so two sweeps pay once.
        const claimed = await reviews.updateOne(
          { _id: review._id, reward: { $exists: false } },
          { $set: { reward: { amount: s.amount, at: now } } },
          { session },
        );
        if (!claimed.modifiedCount) return;
        await db
          .collection('reviewRewards')
          .insertOne(
            { userId: review.userId, productId: review.productId, reviewId: review._id, amount: s.amount, at: now },
            { session },
          );
        balance = await addCredit(
          db,
          review.userId,
          s.amount,
          { reason: 'review', note: product?.title ?? 'A review' },
          session,
        );
      });
    } catch (err) {
      // Two of the customer's reviews of one product paid at the same moment: the unique index lets one through,
      // and this one is marked unpaid.
      if (err.code !== 11000) throw err;
      await reviews.updateOne(
        { _id: review._id, reward: { $exists: false } },
        { $set: { reward: { amount: 0, at: now } } },
      );
      continue;
    } finally {
      await session.endSession();
    }
    if (balance === null) continue;
    paid += 1;
    const user = await db.collection('users').findOne({ _id: review.userId }, { projection: { name: 1, email: 1 } });
    if (!user) continue;
    try {
      await ctx.mail.send({
        to: { email: user.email, name: user.name },
        ...reviewRewardEmail(user, product?.title ?? 'a product', s.amount, balance, ctx.config.mail?.publicUrl),
      });
    } catch (err) {
      console.error(`Could not email the review reward for review ${review._id}:`, err.message);
    }
  }
  return paid;
}

export function reviewRewardRouter({ db }) {
  const router = express.Router();

  // For the review form's note: { amount, minChars } while rewards are on, else null.
  router.get('/review-rewards', async (req, res) => {
    const s = await reviewRewardSettings(db);
    res.json(s.enabled ? { amount: s.amount, minChars: s.minChars, settleDays: SETTLE_DAYS } : null);
  });

  router.use('/admin/review-rewards', requireAdmin);

  router.get('/admin/review-rewards', async (req, res) => {
    const s = await reviewRewardSettings(db);
    const [stats] = await db
      .collection('reviewRewards')
      .aggregate([{ $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } }])
      .toArray();
    res.json({
      enabled: s.enabled,
      amount: s.amount,
      minChars: s.minChars,
      monthlyCap: s.monthlyCap,
      since: s.since,
      paid: { count: stats?.count ?? 0, total: stats?.total ?? 0 },
    });
  });

  router.put('/admin/review-rewards', async (req, res) => {
    const body = parse(settingsBody, req.body);
    const before = await reviewRewardSettings(db);
    // Switching on starts the clock: only reviews written from now earn a reward.
    const since = body.enabled && !before.enabled ? new Date() : before.since;
    await db.collection('settings').updateOne({ _id: SETTINGS }, { $set: { ...body, since } }, { upsert: true });
    const text = (x) =>
      x.enabled
        ? `${rupees(x.amount)} for a review with a photo and ${x.minChars}+ characters, up to ${x.monthlyCap} a month`
        : 'off';
    if (text(before) !== text(body)) {
      await logActivity(db, req.user, {
        area: 'reviews',
        action: 'Changed review rewards',
        target: { label: 'Review rewards', path: '/admin/reviews' },
        changes: [{ field: 'Review rewards', from: text(before), to: text(body) }],
      });
    }
    res.json({ ...body, since });
  });

  return router;
}
