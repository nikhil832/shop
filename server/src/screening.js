import express from 'express';
import { can, requireStaff } from './staff.js';
import { logActivity } from './activity.js';
import { HttpError, parseObjectId } from './http.js';

// Screening (stage 61): Claude reads each new or edited review (with words) and each question for abuse, spam or
// personal details, and flags the doubtful ones for an admin; nothing is hidden automatically. It runs from the minute
// sweep (screenPosts), so posting stays instant, PER_SWEEP at a time, oldest first; reviews and questions from before
// it are screened too. Each post gets `screening` { of (the version it covers: updatedAt or createdAt), at, flagged,
// reasons, note, model, failed?, cleared? }: claimed by writing it with the previous `of` in the filter, so it's done
// once per version, and an edited review is screened again. A failed call is logged and not retried until the post
// changes. Admins see flagged posts under "Flagged" (FLAGGED) and mark false alarms "Looks fine" (`cleared`).

export const SCREEN_REASONS = ['abuse', 'spam', 'personal_details', 'other'];
const PER_SWEEP = 5;

// Flagged, not cleared by an admin, and still shown (hiding is the other way to deal with one).
export const FLAGGED = { 'screening.flagged': true, 'screening.cleared': { $ne: true }, hidden: false };

// What each kind of post is, for the sweep: where it lives, its words, its version and its product.
const KINDS = {
  review: {
    collection: 'reviews',
    // Stars-only reviews have nothing to read.
    hasWords: { $or: [{ title: { $gt: '' } }, { body: { $gt: '' } }] },
    version: (doc) => doc.updatedAt ?? doc.createdAt,
    versionField: { $ifNull: ['$updatedAt', '$createdAt'] },
    text: (doc) => [doc.title, doc.body].filter(Boolean).join('\n\n'),
  },
  question: {
    collection: 'questions',
    hasWords: {},
    version: (doc) => doc.createdAt,
    versionField: '$createdAt',
    text: (doc) => doc.text,
  },
};

// Screens the posts due now. Returns how many it looked at.
export async function screenPosts(ctx, now = new Date()) {
  const { db, ai } = ctx;
  if (!ai) return 0;
  let looked = 0;
  for (const [kind, k] of Object.entries(KINDS)) {
    const posts = db.collection(k.collection);
    const due = await posts
      .find({
        ...k.hasWords,
        $expr: { $lt: [{ $ifNull: ['$screening.of', new Date(0)] }, k.versionField] },
      })
      .sort({ createdAt: 1 })
      .limit(PER_SWEEP)
      .toArray();
    for (const doc of due) {
      looked += 1;
      const of = k.version(doc);
      const claim = await posts.updateOne(
        { _id: doc._id, 'screening.of': doc.screening?.of ?? { $exists: false } },
        { $set: { screening: { of, at: now, flagged: false, reasons: [], note: '', model: ai.model } } },
      );
      if (!claim.modifiedCount) continue;
      const product = await db.collection('products').findOne({ _id: doc.productId }, { projection: { title: 1 } });
      try {
        const result = await ai.screenPost({ kind, product: product?.title ?? 'a product', text: k.text(doc) });
        await posts.updateOne(
          { _id: doc._id, 'screening.of': of },
          {
            $set: {
              'screening.flagged': result.flagged,
              'screening.reasons': result.reasons,
              'screening.note': result.note,
            },
          },
        );
      } catch (err) {
        console.error(`Could not screen ${kind} ${doc._id}:`, err.message);
        await posts.updateOne({ _id: doc._id, 'screening.of': of }, { $set: { 'screening.failed': true } });
      }
    }
  }
  return looked;
}

// For the admin lists: what screening found, or null when it hasn't run (or failed).
export const toScreening = (doc) =>
  doc.screening && !doc.screening.failed && doc.screening.reasons
    ? {
        flagged: doc.screening.flagged,
        reasons: doc.screening.reasons,
        note: doc.screening.note,
        cleared: Boolean(doc.screening.cleared),
      }
    : null;

export function screeningRouter({ db }) {
  const router = express.Router();
  router.use('/admin/screening', requireStaff);

  // "Looks fine": clears a flag the admin disagrees with. Only a flagged, uncleared post changes; that's logged.
  router.post('/admin/screening/:kind/:id/clear', async (req, res) => {
    const k = KINDS[req.params.kind];
    if (!k) throw new HttpError(404, 'Not found');
    if (!can(req.user, req.params.kind === 'review' ? 'reviews' : 'questions')) {
      throw new HttpError(403, "Your account can't do this");
    }
    const _id = parseObjectId(req.params.id, `${req.params.kind} id`);
    const posts = db.collection(k.collection);
    const before = await posts.findOneAndUpdate(
      { _id, 'screening.flagged': true, 'screening.cleared': { $ne: true } },
      { $set: { 'screening.cleared': true, 'screening.clearedBy': req.user._id } },
    );
    if (!before) {
      if (!(await posts.findOne({ _id }, { projection: { _id: 1 } }))) throw new HttpError(404, 'Not found');
    } else {
      const product = await db.collection('products').findOne({ _id: before.productId }, { projection: { title: 1 } });
      const text = k.text(before);
      await logActivity(db, req.user, {
        area: req.params.kind === 'review' ? 'reviews' : 'questions',
        action: 'Cleared a flag',
        target: {
          label: `${product?.title ?? 'A product'}: “${text.length > 60 ? `${text.slice(0, 59)}…` : text}”`,
          path: req.params.kind === 'review' ? '/admin/reviews' : '/admin/questions',
        },
        changes: [{ field: 'Flagged for', to: before.screening.reasons.join(', ') || 'other' }],
      });
    }
    res.status(204).end();
  });

  return router;
}
