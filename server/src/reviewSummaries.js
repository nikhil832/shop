import express from 'express';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { logActivity } from './activity.js';
import { parse } from './http.js';

// "What customers say" (stage 60): a short summary of a product's visible written reviews,
// written by Claude and shown above them. It's rewritten only when the reviews change: changeRating() (every review
// write, delete, hide and show) stamps `products.reviewsChangedAt`, and updateReviewSummaries(), from the minute sweep,
// takes products changed at least SETTLE_MS ago (so a burst of edits costs one call) that haven't been checked since,
// or that have reviews but were never checked. With fewer than MIN_REVIEWS written reviews the summary goes. Stored as
// `products.reviewSummary` { text, count, at, model }; `reviewSummaryCheckedAt` (the reviewsChangedAt it covered) claims
// the work, so it's done once.
// Admins switch it off for the store (`settings` { _id: 'reviewSummaries', enabled: false }): then none are shown or
// written. Needs the writing assistant (ANTHROPIC_API_KEY).

export const MIN_REVIEWS = 3;
export const SETTLE_MS = 5 * 60_000;
const PER_SWEEP = 3;
const MAX_REVIEWS = 100; // the newest, if a product has more
const SETTINGS_ID = 'reviewSummaries';

const enabledIn = async (db) => (await db.collection('settings').findOne({ _id: SETTINGS_ID }))?.enabled !== false;

// Written reviews that count: shown, with a title or some text.
const writtenReviews = (productId) => ({
  productId,
  hidden: false,
  $or: [{ title: { $gt: '' } }, { body: { $gt: '' } }],
});

// The summary to show with a product's reviews, or null (none yet, or switched off).
export async function publicSummary(db, productId) {
  const [product, enabled] = await Promise.all([
    db.collection('products').findOne({ _id: productId }, { projection: { reviewSummary: 1 } }),
    enabledIn(db),
  ]);
  const s = enabled && product?.reviewSummary;
  return s ? { text: s.text, count: s.count, at: s.at } : null;
}

// Rewrites the summaries due now (at most PER_SWEEP). Returns how many products it looked at.
export async function updateReviewSummaries(ctx, now = new Date()) {
  const { db, ai } = ctx;
  if (!ai || !(await enabledIn(db))) return 0;
  const products = db.collection('products');
  const due = await products
    .find(
      {
        $or: [
          // Reviews changed since the last check, and not just now.
          {
            reviewsChangedAt: { $lte: new Date(now.getTime() - SETTLE_MS) },
            $expr: { $gt: ['$reviewsChangedAt', { $ifNull: ['$reviewSummaryCheckedAt', new Date(0)] }] },
          },
          // Products with reviews from before summaries existed.
          { reviewSummaryCheckedAt: { $exists: false }, 'reviewStats.count': { $gte: MIN_REVIEWS } },
        ],
      },
      { projection: { title: 1, reviewsChangedAt: 1, reviewSummaryCheckedAt: 1 } },
    )
    .sort({ reviewsChangedAt: 1 })
    .limit(PER_SWEEP)
    .toArray();

  for (const product of due) {
    // Claimed with the previous check in the filter, so simultaneous sweeps do it once. The check records the change
    // it covers (not the clock), so a review written while this runs is due again afterwards.
    const claim = await products.updateOne(
      { _id: product._id, reviewSummaryCheckedAt: product.reviewSummaryCheckedAt ?? { $exists: false } },
      { $set: { reviewSummaryCheckedAt: product.reviewsChangedAt ?? now } },
    );
    if (!claim.modifiedCount) continue;
    const reviews = await db
      .collection('reviews')
      .find(writtenReviews(product._id), { projection: { rating: 1, title: 1, body: 1 } })
      .sort({ createdAt: -1 })
      .limit(MAX_REVIEWS)
      .toArray();
    if (reviews.length < MIN_REVIEWS) {
      await products.updateOne({ _id: product._id }, { $unset: { reviewSummary: '' } });
      continue;
    }
    try {
      const text = await ai.summarizeReviews({
        title: product.title,
        reviews: reviews.map((r) => ({ rating: r.rating, title: r.title ?? '', body: r.body ?? '' })),
      });
      await products.updateOne(
        { _id: product._id },
        { $set: { reviewSummary: { text, count: reviews.length, at: now, model: ai.model } } },
      );
    } catch (err) {
      // The old summary stays; the next change to the reviews tries again.
      console.error(`Could not summarise the reviews of ${product.title}:`, err.message);
    }
  }
  return due.length;
}

const switchBody = z.object({ enabled: z.boolean('Say whether to show them: true or false') });

export function reviewSummariesRouter({ db, ai }) {
  const router = express.Router();
  router.use('/admin/review-summaries', requireAdmin);

  // For the admin reviews page: whether summaries can be written (an API key) and whether they're on.
  router.get('/admin/review-summaries', async (req, res) => {
    res.json({ available: Boolean(ai), enabled: await enabledIn(db) });
  });

  router.put('/admin/review-summaries', async (req, res) => {
    const { enabled } = parse(switchBody, req.body);
    const before = await db
      .collection('settings')
      .findOneAndUpdate({ _id: SETTINGS_ID }, { $set: { enabled } }, { upsert: true, returnDocument: 'before' });
    if ((before?.enabled !== false) !== enabled) {
      await logActivity(db, req.user, {
        area: 'reviews',
        action: enabled ? 'Switched on review summaries' : 'Switched off review summaries',
      });
    }
    res.json({ available: Boolean(ai), enabled });
  });

  return router;
}
