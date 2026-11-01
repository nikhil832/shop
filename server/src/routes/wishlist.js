import express from 'express';
import { randomBytes } from 'node:crypto';
import { requireUser } from '../auth.js';
import { z } from 'zod';
import { HttpError, parse, parseObjectId } from '../http.js';
import { toProductCard } from './catalog.js';
import { priceDropEmail, priceTargetEmail } from '../emails.js';

export const WISHLIST_LIMIT = 200;
// A price-drop email needs the price at least this much lower than the one the customer last saw (saved or emailed).
export const PRICE_DROP_PERCENT = 5;

// The wishlist is saved in the account: one `wishlist` document per (user, product), `{ userId, productId, addedAt,
// seenPrice }` where seenPrice is the product's price when saved, lowered each time a price-drop email tells of a lower one.
// Price targets (stage 142): `targetPrice` (paise, whole rupees, below the price when set) and `targetSentAt` once
// sendPriceTargetEmails has told the customer it got there. An item waiting for its target is left out of the 5%
// price-drop emails, so one drop never sends both.
const targetBody = z.object({
  targetPrice: z
    .number()
    .int()
    .min(100, 'targetPrice: At least ₹1')
    .refine((v) => v % 100 === 0, 'targetPrice: Use whole rupees')
    .nullable(),
});
const WAITING_FOR_TARGET = { targetPrice: { $type: 'number' }, targetSentAt: { $exists: false } };
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
    res.json(
      docs.map((d) => ({
        ...toProductCard(d.product),
        addedAt: d.addedAt,
        // { price, reachedAt } or null (stage 142).
        target: d.targetPrice ? { price: d.targetPrice, reachedAt: d.targetSentAt ?? null } : null,
      })),
    );
  });

  // Sharing (stage 106; before the routes with :productId, which would take "share" as an id): a link anyone can open, showing the customer's first name and their wishlist's shown
  // products, never anything else about them. `users.wishlistShare` { token, since } holds it: 18 random bytes, so
  // links can't be guessed. Stopping removes it, so the old link stops working and sharing again makes a new one.
  const users = db.collection('users');
  const shareOf = (user) => (user.wishlistShare ? { token: user.wishlistShare.token } : null);

  router.get('/wishlist/share', async (req, res) => {
    res.json({ share: shareOf(req.user) });
  });

  router.post('/wishlist/share', async (req, res) => {
    if (req.user.wishlistShare) return res.json({ share: shareOf(req.user) });
    const wishlistShare = { token: randomBytes(18).toString('base64url'), since: new Date() };
    const after = await users.findOneAndUpdate(
      { _id: req.user._id, wishlistShare: { $exists: false } },
      { $set: { wishlistShare } },
      { returnDocument: 'after' },
    );
    // Two tabs at once: the other one's link stands.
    res.json({ share: shareOf(after ?? (await users.findOne({ _id: req.user._id }))) });
  });

  router.delete('/wishlist/share', async (req, res) => {
    await users.updateOne({ _id: req.user._id }, { $unset: { wishlistShare: '' } });
    res.json({ share: null });
  });

  // The shared list itself, for anyone with the link: the first name and the shown products, newest first.
  router.get('/shared-wishlists/:token', async (req, res) => {
    const token = req.params.token;
    const owner = /^[\w-]{20,40}$/.test(token)
      ? await users.findOne({ 'wishlistShare.token': token }, { projection: { name: 1 } })
      : null;
    if (!owner) throw new HttpError(404, 'This wishlist link has been switched off or never existed');
    const docs = await wishlist
      .aggregate([
        { $match: { userId: owner._id } },
        { $sort: { addedAt: -1, _id: -1 } },
        { $limit: WISHLIST_LIMIT },
        { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'product' } },
        { $unwind: '$product' },
        { $match: { 'product.active': true } },
      ])
      .toArray();
    res.json({ name: owner.name.split(/\s+/)[0], items: docs.map((d) => toProductCard(d.product)) });
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

  // The customer's price target for a saved product (stage 142); null removes it. Setting one starts it afresh.
  router.put('/wishlist/:productId/target', async (req, res) => {
    const productId = parseObjectId(req.params.productId, 'product id');
    const { targetPrice } = parse(targetBody, req.body);
    const saved = await wishlist.findOne({ userId: req.user._id, productId });
    if (!saved) throw new HttpError(404, 'Save it to your wishlist first');
    if (targetPrice !== null) {
      const product = await products.findOne({ _id: productId }, { projection: { price: 1 } });
      if (product && targetPrice >= product.price) {
        throw new HttpError(
          400,
          `targetPrice: It's ₹${(product.price / 100).toLocaleString('en-IN')} now: choose a lower price`,
        );
      }
    }
    await wishlist.updateOne(
      { _id: saved._id },
      targetPrice === null
        ? { $unset: { targetPrice: '', targetSentAt: '' } }
        : { $set: { targetPrice }, $unset: { targetSentAt: '' } },
    );
    res.json({ target: targetPrice === null ? null : { price: targetPrice, reachedAt: null } });
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
      // Items waiting for their own price target (stage 142) get that email instead.
      { $match: { seenPrice: { $exists: true }, $nor: [WAITING_FOR_TARGET] } },
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

// Run every minute after the price-drop emails (stage 142): wishlist items whose product is shown, in stock and now at
// or below the customer's target, one email per customer listing them. Sent even with price-drop emails switched
// off, as the customer asked for this one. Each item is claimed by setting targetSentAt (missing in the filter) and its
// seenPrice moves to the new price, so the 5% emails start from there; a failed send undoes both. Returns emails sent.
export async function sendPriceTargetEmails(ctx, now = new Date()) {
  const { db } = ctx;
  const wishlist = db.collection('wishlist');
  const due = await wishlist
    .aggregate([
      { $match: WAITING_FOR_TARGET },
      { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'product' } },
      { $unwind: '$product' },
      {
        $match: {
          'product.active': true,
          'product.stock': { $gt: 0 },
          $expr: { $lte: ['$product.price', '$targetPrice'] },
        },
      },
      { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
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
        { _id: w._id, targetPrice: w.targetPrice, targetSentAt: { $exists: false } },
        { $set: { targetSentAt: now, seenPrice: w.product.price } },
      );
      if (modifiedCount) claimed.push(w);
    }
    if (!claimed.length) continue;
    const { user } = claimed[0];
    try {
      const email = priceTargetEmail(
        user,
        claimed.map((w) => ({ product: w.product, target: w.targetPrice })),
        ctx.config.mail?.publicUrl,
      );
      await ctx.mail.send({ to: { email: user.email, name: user.name }, ...email });
      sent++;
    } catch (err) {
      console.error(`Could not send a price-target email to user ${user._id}:`, err.message);
      await wishlist.bulkWrite(
        claimed.map((w) => ({
          updateOne: {
            filter: { _id: w._id, targetSentAt: now },
            update: { $unset: { targetSentAt: '' }, $set: { seenPrice: w.seenPrice } },
          },
        })),
      );
    }
  }
  return sent;
}
