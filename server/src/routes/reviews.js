import express from 'express';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { ObjectId } from 'mongodb';
import { HttpError, parse } from '../http.js';
import { UPLOAD_URL } from './images.js';

const REVIEW_PAGE = 10;

export const MAX_REVIEW_PHOTOS = 3;
const reviewBody = z.object({
  rating: z.number().int().min(1, 'Choose 1 to 5 stars').max(5, 'Choose 1 to 5 stars'),
  title: z.string().trim().max(100).default(''),
  body: z.string().trim().max(2000).default(''),
  // Photos the reviewer uploaded (POST /reviews/photos), as their /api/images/… addresses.
  photos: z
    .array(z.string().regex(UPLOAD_URL, 'Invalid photo'))
    .max(MAX_REVIEW_PHOTOS, `At most ${MAX_REVIEW_PHOTOS} photos`)
    .default([])
    .refine((urls) => new Set(urls).size === urls.length, 'The same photo twice'),
});
const listQuery = z.object({ page: z.coerce.number().int().min(1).max(1000).default(1) });

// "Asha Rao" → "Asha R.": enough to tell reviewers apart without showing full names.
export const shortName = (name) => {
  const [first, ...rest] = name.trim().split(/\s+/);
  return rest.length ? `${first} ${rest.at(-1)[0].toUpperCase()}.` : first;
};

export const toReview = (doc) => ({
  id: doc._id.toString(),
  rating: doc.rating,
  title: doc.title,
  body: doc.body,
  author: doc.author,
  photos: doc.photos ?? [],
  hidden: doc.hidden,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

// Adds `sum`/`count` (deltas from a review change) to the product's rating. The sample catalog came with ratings
// that have no review documents behind them; they are kept as `ratingBase` (copied from `rating` the first time) and
// `rating` = base + visible reviews. One update pipeline, so it's atomic per product.
export function changeRating(db, productId, { sum, count }, session) {
  const total = { $add: ['$ratingBase.count', '$reviewStats.count'] };
  return db.collection('products').updateOne(
    { _id: productId },
    [
      {
        $set: {
          ratingBase: { $ifNull: ['$ratingBase', '$rating'] },
          reviewStats: {
            sum: { $add: [{ $ifNull: ['$reviewStats.sum', 0] }, sum] },
            count: { $add: [{ $ifNull: ['$reviewStats.count', 0] }, count] },
          },
        },
      },
      {
        $set: {
          rating: {
            count: total,
            avg: {
              $cond: [
                { $eq: [total, 0] },
                0,
                {
                  $round: [
                    {
                      $divide: [
                        { $add: [{ $multiply: ['$ratingBase.avg', '$ratingBase.count'] }, '$reviewStats.sum'] },
                        total,
                      ],
                    },
                    1,
                  ],
                },
              ],
            },
          },
        },
      },
    ],
    { session },
  );
}

// Runs `work(session)` in a transaction, so a review and its product's rating always change together.
export async function inTransaction(client, work) {
  const session = client.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export function reviewsRouter({ db, client }) {
  const products = db.collection('products');
  const reviews = db.collection('reviews');
  const orders = db.collection('orders');
  const router = express.Router();

  async function findProduct(slug) {
    const product = await products.findOne({ slug, active: true }, { projection: { _id: 1 } });
    if (!product) throw new HttpError(404, 'Product not found');
    return product;
  }

  // Only buyers review: someone with a delivered order containing the product.
  const hasReceived = async (userId, productId) =>
    Boolean(
      await orders.findOne({ userId, status: 'delivered', 'items.productId': productId }, { projection: { _id: 1 } }),
    );

  router.get('/products/:slug/reviews', async (req, res) => {
    const { page } = parse(listQuery, req.query);
    const { _id: productId } = await findProduct(req.params.slug);
    const filter = { productId, hidden: false };
    const [docs, total, viewer] = await Promise.all([
      reviews
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * REVIEW_PAGE)
        .limit(REVIEW_PAGE)
        .toArray(),
      reviews.countDocuments(filter),
      req.user &&
        Promise.all([reviews.findOne({ productId, userId: req.user._id }), hasReceived(req.user._id, productId)]),
    ]);
    res.json({
      items: docs.map(toReview),
      total,
      page,
      pageSize: REVIEW_PAGE,
      // For a logged-in visitor: their own review (even if hidden) and whether they may write one.
      viewer: viewer ? { review: viewer[0] && toReview(viewer[0]), canReview: viewer[1] } : null,
    });
  });

  // Creates or replaces the visitor's review of this product.
  router.put('/products/:slug/review', requireUser, async (req, res) => {
    const input = parse(reviewBody, req.body);
    const { _id: productId } = await findProduct(req.params.slug);
    const userId = req.user._id;
    // Only the reviewer's own review uploads (not another customer's, nor an admin's product photos).
    if (input.photos.length) {
      const ids = input.photos.map((u) => new ObjectId(u.match(UPLOAD_URL)[1]));
      const mine = await db
        .collection('images')
        .countDocuments({ _id: { $in: ids }, uploadedBy: userId, kind: 'review' });
      if (mine !== ids.length) throw new HttpError(400, 'photos: Upload the photos again');
    }
    if (!(await hasReceived(userId, productId))) {
      throw new HttpError(403, 'You can review this once an order with it has been delivered to you');
    }
    const now = new Date();
    try {
      const doc = await inTransaction(client, async (session) => {
        const old = await reviews.findOne({ productId, userId }, { session });
        const fields = { ...input, author: shortName(req.user.name), updatedAt: now };
        if (old) {
          await reviews.updateOne({ _id: old._id }, { $set: fields }, { session });
          // A hidden review stays hidden after an edit and keeps out of the rating.
          if (!old.hidden) await changeRating(db, productId, { sum: input.rating - old.rating, count: 0 }, session);
          return { ...old, ...fields };
        }
        const review = { productId, userId, ...fields, hidden: false, createdAt: now };
        const { insertedId } = await reviews.insertOne(review, { session });
        await changeRating(db, productId, { sum: input.rating, count: 1 }, session);
        return { _id: insertedId, ...review };
      });
      res.json(toReview(doc));
    } catch (err) {
      // Two first reviews sent at the same moment: the unique index lets only one in.
      if (err.code === 11000) throw new HttpError(409, 'Your review was just saved from another tab. Reload to see it');
      throw err;
    }
  });

  router.delete('/products/:slug/review', requireUser, async (req, res) => {
    const { _id: productId } = await findProduct(req.params.slug);
    await inTransaction(client, async (session) => {
      const old = await reviews.findOneAndDelete({ productId, userId: req.user._id }, { session });
      if (!old) throw new HttpError(404, "You haven't reviewed this product");
      if (!old.hidden) await changeRating(db, productId, { sum: -old.rating, count: -1 }, session);
    });
    res.status(204).end();
  });

  return router;
}
