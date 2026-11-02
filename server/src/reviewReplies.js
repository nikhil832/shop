import express from 'express';
import { z } from 'zod';
import { requirePermission } from './staff.js';
import { HttpError, parse, parseObjectId } from './http.js';
import { logActivity } from './activity.js';
import { lowReviewEmail, sendReviewReply, sendToAdmins } from './emails.js';

// Replies to reviews (stage 148). Admins and support staff (the 'reviews' permission) answer a review in public:
// `reviews.reply` { text, by: { id, name }, at (the first reply's time, kept on edits), updatedAt }. The product page
// shows it as the store's ("Reply from Bazaar"), never the staff member's name. The reviewer is emailed on the first
// reply only. A reply never touches the review's own `updatedAt`, which screening uses as the review's version.
// Admins are emailed about a new review of LOW_RATING stars or fewer, or one edited down to it, so they can reply
// quickly; NEEDS_REPLY (shown, low, no reply) is Admin → Reviews' "Needs a reply" and the dashboard's count.

export const LOW_RATING = 2;
export const MAX_REPLY = 1000;
export const NEEDS_REPLY = { hidden: false, rating: { $lte: LOW_RATING }, reply: { $exists: false } };

// Called after a review is saved: `before` is the earlier version, or null for a new review.
export async function noteLowReview(ctx, review, before) {
  if (review.rating > LOW_RATING || (before && before.rating <= LOW_RATING)) return;
  const product = await ctx.db.collection('products').findOne({ _id: review.productId }, { projection: { title: 1 } });
  if (!product) return;
  await sendToAdmins(ctx, lowReviewEmail(review, product, ctx.config.mail?.publicUrl), 'a low review alert');
}

const replyBody = z.object({
  text: z.string().trim().min(1, 'Write the reply').max(MAX_REPLY, `At most ${MAX_REPLY} characters`),
});

const target = (product) => ({ label: `Review of ${product?.title ?? 'a product'}`, path: '/admin/reviews' });

export function reviewRepliesRouter(ctx) {
  const { db } = ctx;
  const reviews = db.collection('reviews');
  const router = express.Router();
  router.use('/admin/reviews/:id/reply', requirePermission('reviews'));

  const productOf = (review) =>
    db.collection('products').findOne({ _id: review.productId }, { projection: { title: 1, slug: 1 } });

  router.put('/admin/reviews/:id/reply', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'review id');
    const { text } = parse(replyBody, req.body);
    const now = new Date();
    const by = { id: req.user._id, name: req.user.name };
    // The first reply, or else an edit of it: the filters decide, so two staff replying at once send one email.
    const first = await reviews.findOneAndUpdate(
      { _id, reply: { $exists: false } },
      { $set: { reply: { text, by, at: now, updatedAt: now } } },
      { returnDocument: 'after' },
    );
    let review = first;
    let before = null;
    if (!first) {
      before = await reviews.findOneAndUpdate(
        { _id, reply: { $exists: true } },
        { $set: { 'reply.text': text, 'reply.by': by, 'reply.updatedAt': now } },
      );
      if (!before) throw new HttpError(404, 'Review not found');
      review = { ...before, reply: { ...before.reply, text, by, updatedAt: now } };
    }
    const product = await productOf(review);
    if (first) {
      await logActivity(db, req.user, {
        area: 'reviews',
        action: 'Replied to a review',
        target: target(product),
        changes: [{ field: 'Reply', to: text }],
      });
      await sendReviewReply(ctx, review, product);
    } else if (before.reply.text !== text) {
      await logActivity(db, req.user, {
        area: 'reviews',
        action: 'Edited a reply',
        target: target(product),
        changes: [{ field: 'Reply', from: before.reply.text, to: text }],
      });
    }
    res.json(toReply(review, true));
  });

  router.delete('/admin/reviews/:id/reply', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'review id');
    const before = await reviews.findOneAndUpdate({ _id, reply: { $exists: true } }, { $unset: { reply: '' } });
    if (!before) {
      if (!(await reviews.findOne({ _id }, { projection: { _id: 1 } }))) throw new HttpError(404, 'Review not found');
      return res.status(204).end();
    }
    await logActivity(db, req.user, {
      area: 'reviews',
      action: 'Removed a reply',
      target: target(await productOf(before)),
      changes: [{ field: 'Reply', from: before.reply.text }],
    });
    res.status(204).end();
  });

  return router;
}

// The reply as the API gives it: null without one. Admins also get who wrote it and whether the customer has edited
// their review since.
export function toReply(doc, admin = false) {
  const r = doc.reply;
  if (!r) return null;
  return {
    text: r.text,
    at: r.at,
    updatedAt: r.updatedAt,
    ...(admin && { by: r.by?.name ?? null, reviewEditedSince: Boolean(doc.updatedAt && doc.updatedAt > r.updatedAt) }),
  };
}
