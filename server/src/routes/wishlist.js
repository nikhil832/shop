import express from 'express';
import { requireUser } from '../auth.js';
import { HttpError, parseObjectId } from '../http.js';
import { toProductCard } from './catalog.js';
import { priceDropEmail } from '../emails.js';

export const WISHLIST_LIMIT = 200;
// A price-drop email needs the price at least this much lower than the one the customer last saw (saved or emailed).
export const PRICE_DROP_PERCENT = 5;

// The wishlist is saved in the account: one `wishlist` document per (user, product), `{ userId, productId, addedAt,
// seenPrice }` where seenPrice is the product's price when saved, lowered each time a price-drop email tells of a lower one.
export function wishlistRouter({ db }) {
  const wishlist = db.collection('wishlist');
  const products = db.collection('products');
  const router = express.Router();
  router.use('/wishlist', requireUser);

  // Newest first. Products an admin has since hidden are left out (and come back if shown again).
  router.get('/wishlist', async (req, res) => {
    const docs = await wishlist
      .aggregate([
        { $match: { userId: req.user._id } },
        { $sort: { addedAt: -1, _id: -1 } },
        { $limit: WISHLIST_LIMIT },
        { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'product' } },
        { $unwind: '$product' },
        { $match: { 'product.active': true } },
      ])
      .toArray();
    res.json(docs.map((d) => ({ ...toProductCard(d.product), addedAt: d.addedAt })));
  });

  router.put('/wishlist/:productId', async (req, res) => {
    const productId = parseObjectId(req.params.productId, 'product id');
    const product = await products.findOne({ _id: productId, active: true }, { projection: { price: 1 } });
    if (!product) throw new HttpError(404, 'Product not found');
    const userId = req.user._id;
    if ((await wishlist.countDocuments({ userId })) >= WISHLIST_LIMIT) {
      // Saving one that's already there is fine even when full.
      if (!(await wishlist.findOne({ userId, productId }))) {
        throw new HttpError(409, `Your wishlist is full (${WISHLIST_LIMIT} items). Remove something first`);
      }
    }
    await wishlist.updateOne(
      { userId, productId },
      { $setOnInsert: { addedAt: new Date(), seenPrice: product.price } },
      { upsert: true },
    );
    res.json({ saved: true });
  });

  router.delete('/wishlist/:productId', async (req, res) => {
    const productId = parseObjectId(req.params.productId, 'product id');
    await wishlist.deleteOne({ userId: req.user._id, productId });
    res.json({ saved: false });
  });

  return router;
}

// Run every minute by index.js (and directly by tests). Emails each customer whose wishlist has products, shown and in
// stock, now at least PRICE_DROP_PERCENT cheaper than the price they last saw: one email per customer, listing them.
// Each item is claimed by moving its seenPrice to the new price (so a price that rises and falls back isn't news), and
// put back if the email fails, for the next sweep. Customers who switched these emails off (users.priceDropEmails:
// false) are skipped. Saved items from before this existed get the current price first, without an email.
// Returns the number of emails sent.
export async function sendPriceDropEmails(ctx) {
  const { db } = ctx;
  const wishlist = db.collection('wishlist');
  const unseen = await wishlist
    .aggregate([
      { $match: { seenPrice: { $exists: false } } },
      { $limit: 1000 },
      { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'product' } },
      { $unwind: '$product' },
    ])
    .toArray();
  if (unseen.length) {
    await wishlist.bulkWrite(
      unseen.map((w) => ({
        updateOne: {
          filter: { _id: w._id, seenPrice: { $exists: false } },
          update: { $set: { seenPrice: w.product.price } },
        },
      })),
    );
  }

  const due = await wishlist
    .aggregate([
      { $match: { seenPrice: { $exists: true } } },
      { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'product' } },
      { $unwind: '$product' },
      {
        $match: {
          'product.active': true,
          'product.stock': { $gt: 0 },
          $expr: { $lte: ['$product.price', { $multiply: ['$seenPrice', (100 - PRICE_DROP_PERCENT) / 100] }] },
        },
      },
      { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      { $match: { 'user.priceDropEmails': { $ne: false } } },
      { $sort: { userId: 1, addedAt: -1 } },
      { $limit: 1000 },
    ])
    .toArray();

  const byUser = new Map();
  for (const w of due) {
    const key = w.userId.toString();
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push(w);
  }
  let sent = 0;
  for (const items of byUser.values()) {
    const claimed = [];
    for (const w of items) {
      const { modifiedCount } = await wishlist.updateOne(
        { _id: w._id, seenPrice: w.seenPrice },
        { $set: { seenPrice: w.product.price } },
      );
      if (modifiedCount) claimed.push(w); // otherwise another sweep has it
    }
    if (!claimed.length) continue;
    const { user } = claimed[0];
    try {
      const email = priceDropEmail(
        user,
        claimed.map((w) => ({ product: w.product, from: w.seenPrice, to: w.product.price })),
        ctx.config.mail?.publicUrl,
      );
      await ctx.mail.send({ to: { email: user.email, name: user.name }, ...email });
      sent++;
    } catch (err) {
      console.error(`Could not send a price-drop email to user ${user._id}:`, err.message);
      await wishlist.bulkWrite(
        claimed.map((w) => ({
          updateOne: {
            filter: { _id: w._id, seenPrice: w.product.price },
            update: { $set: { seenPrice: w.seenPrice } },
          },
        })),
      );
    }
  }
  return sent;
}
