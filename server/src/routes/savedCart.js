import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { cartReminderEmail } from '../emails.js';
import { parse } from '../http.js';
import { savedCartLines } from './orders.js';

// The cart of a logged-in customer, saved in the account (collection `carts`, one document per user: `{ _id: userId,
// items, updatedAt, remindedAt? }`), so it follows them between devices. The browser keeps its own copy and sends
// every change (client/src/cartSync.jsx); prices are never stored, only what's in it. A cart left alone for a day
// gets one reminder email.

export const REMIND_AFTER_MS = 24 * 3_600_000;
const REMIND_UNTIL_MS = 7 * 24 * 3_600_000; // older carts are let go

const savedCartBody = z.object({ items: savedCartLines });
// Stored with ObjectIds (the reminder looks the products up), sent as hex strings like the browser's cart.
const toStored = (items) =>
  items.map(({ productId, variantId, qty }) => ({
    productId: new ObjectId(productId),
    ...(variantId && { variantId: new ObjectId(variantId) }),
    qty,
  }));
const toItems = (items) =>
  items.map(({ productId, variantId, qty }) => ({
    productId: productId.toString(),
    ...(variantId && { variantId: variantId.toString() }),
    qty,
  }));

export function savedCartRouter({ db }) {
  const carts = db.collection('carts');
  const router = express.Router();
  router.use('/cart/saved', requireUser);

  router.get('/cart/saved', async (req, res) => {
    const doc = await carts.findOne({ _id: req.user._id });
    res.json({ items: toItems(doc?.items ?? []), updatedAt: doc?.updatedAt ?? null });
  });

  // Replaces the saved cart (an empty list empties it). A change makes it eligible for a new reminder.
  router.put('/cart/saved', async (req, res) => {
    const { items } = parse(savedCartBody, req.body);
    const updatedAt = new Date();
    await carts.updateOne(
      { _id: req.user._id },
      { $set: { items: toStored(items), updatedAt }, $unset: { remindedAt: '' } },
      { upsert: true },
    );
    res.json({ items, updatedAt });
  });

  return router;
}

// Run every minute by index.js (and directly by tests, with `now`). Emails each customer whose saved cart has been left
// alone for a day (and less than a week), once per cart: not when they have ordered since, nor when nothing in it can
// be bought now, nor when they switched these emails off (users.cartReminderEmails: false). Each cart is claimed by
// setting remindedAt (with its updatedAt in the filter, so a change meanwhile wins), and released if the email fails.
// Returns the number sent.
export async function sendCartReminders(ctx, now = new Date()) {
  const { db } = ctx;
  const carts = db.collection('carts');
  const due = await carts
    .aggregate([
      {
        $match: {
          'items.0': { $exists: true },
          remindedAt: { $exists: false },
          updatedAt: { $lte: new Date(now - REMIND_AFTER_MS), $gt: new Date(now - REMIND_UNTIL_MS) },
        },
      },
      { $limit: 100 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
    ])
    .toArray();
  let sent = 0;
  for (const cart of due) {
    const claimed = await carts.updateOne(
      { _id: cart._id, updatedAt: cart.updatedAt, remindedAt: { $exists: false } },
      { $set: { remindedAt: now } },
    );
    if (!claimed.modifiedCount) continue; // changed meanwhile, or another sweep has it
    const { user } = cart;
    if (user.cartReminderEmails === false) continue;
    if (await db.collection('orders').findOne({ userId: user._id, createdAt: { $gte: cart.updatedAt } })) continue;
    // What can be bought now, at today's prices.
    const products = await db
      .collection('products')
      .find({ _id: { $in: cart.items.map((i) => i.productId) }, active: true })
      .toArray();
    const lines = cart.items
      .map((i) => {
        const product = products.find((p) => p._id.equals(i.productId));
        const variant = i.variantId && product?.variants?.find((v) => v._id.equals(i.variantId));
        const item = variant ?? (i.variantId ? null : product);
        return item && item.stock > 0 ? { product, variant, qty: i.qty, price: item.price } : null;
      })
      .filter(Boolean);
    if (!lines.length) continue;
    try {
      const email = cartReminderEmail(user, lines, ctx.config.mail?.publicUrl);
      await ctx.mail.send({ to: { email: user.email, name: user.name }, ...email });
      sent++;
    } catch (err) {
      console.error(`Could not send a cart reminder to user ${user._id}:`, err.message);
      await carts.updateOne({ _id: cart._id, remindedAt: now }, { $unset: { remindedAt: '' } });
    }
  }
  return sent;
}
