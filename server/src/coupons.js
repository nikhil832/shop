import express from 'express';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { HttpError, parse, parseObjectId } from './http.js';

// Coupon codes. A coupon is { code (upper case, unique), type, value, maxDiscount, minSubtotal, expiresAt,
// usageLimit, usedCount, active }: `percent` takes `value`% off the items (at most `maxDiscount` paise, if set),
// `flat` takes `value` paise off, `free_delivery` waives the delivery charge. Each customer can use a coupon once
// (a `couponRedemptions` document per use, unique per coupon and customer); cancelling the order gives the use back.
// Amounts are paise; the free-delivery threshold applies to the items before any discount.

export const COUPON_TYPES = ['percent', 'flat', 'free_delivery'];
const MAX_PERCENT = 90;

const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
export const couponCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{3,20}$/, 'Use 3–20 letters and digits');

// Checks that the coupon `code` can be used on these totals by this customer (userId may be null for a guest's quote)
// and returns { coupon, discount }, or throws a 409 saying why not. Pass `session` inside a transaction.
export async function couponDiscount(db, code, { subtotal, delivery, userId, session }) {
  const coupon = await db.collection('coupons').findOne({ code: code.trim().toUpperCase() }, { session });
  if (!coupon || !coupon.active) throw new HttpError(409, "This coupon code isn't valid");
  if (coupon.expiresAt && coupon.expiresAt <= new Date()) throw new HttpError(409, 'This coupon has expired');
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
    throw new HttpError(409, 'This coupon has been fully used');
  }
  if (subtotal < coupon.minSubtotal) {
    throw new HttpError(409, `Add ${rupees(coupon.minSubtotal - subtotal)} more to use this coupon`);
  }
  if (userId && (await db.collection('couponRedemptions').findOne({ couponId: coupon._id, userId }, { session }))) {
    throw new HttpError(409, "You've already used this coupon");
  }
  let discount;
  if (coupon.type === 'free_delivery') {
    if (!delivery) throw new HttpError(409, 'Delivery is already free on this order');
    discount = delivery;
  } else if (coupon.type === 'percent') {
    // Rounded down to whole rupees, like every price shown, so the lines of a bill always add up.
    const percentOff = Math.floor((subtotal * coupon.value) / 10_000) * 100;
    discount = Math.min(percentOff, coupon.maxDiscount ?? Infinity);
  } else {
    discount = Math.min(coupon.value, subtotal);
  }
  return { coupon, discount };
}

// Uses up one use of the coupon for an order, inside the order's transaction. The limit check is part of the update
// and the unique index refuses a second use by the same customer, so two orders at once can't both get through.
export async function redeemCoupon(db, coupon, { userId, orderId, session }) {
  const counted = await db.collection('coupons').updateOne(
    {
      _id: coupon._id,
      active: true,
      $or: [{ usageLimit: null }, { $expr: { $lt: ['$usedCount', '$usageLimit'] } }],
    },
    { $inc: { usedCount: 1 } },
    { session },
  );
  if (!counted.modifiedCount) throw new HttpError(409, 'This coupon has been fully used');
  try {
    await db
      .collection('couponRedemptions')
      .insertOne({ couponId: coupon._id, userId, orderId, at: new Date() }, { session });
  } catch (err) {
    if (err.code === 11000) throw new HttpError(409, "You've already used this coupon");
    throw err;
  }
}

// Gives back the coupon use of a cancelled order (inside cancelOrder's transaction), so the customer can use it again.
export async function releaseCoupon(db, orderId, session) {
  const redemption = await db.collection('couponRedemptions').findOneAndDelete({ orderId }, { session });
  if (redemption) {
    await db.collection('coupons').updateOne({ _id: redemption.couponId }, { $inc: { usedCount: -1 } }, { session });
  }
}

const couponBody = z
  .object({
    code: couponCode,
    type: z.enum(COUPON_TYPES),
    // Percent for `percent`, paise for `flat`, unused for `free_delivery`.
    value: z.number().int().min(0).default(0),
    maxDiscount: z.number().int().min(100).nullable().default(null),
    minSubtotal: z.number().int().min(0).default(0),
    expiresAt: z.coerce.date().nullable().default(null),
    usageLimit: z.number().int().min(1).nullable().default(null),
  })
  .superRefine((c, ctx) => {
    if (c.type === 'percent' && (c.value < 1 || c.value > MAX_PERCENT)) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `Enter a percentage from 1 to ${MAX_PERCENT}` });
    }
    if (c.type === 'flat' && c.value < 100) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Enter an amount of at least ₹1' });
    }
    // Whole rupees, like every price, so the lines of a bill add up.
    if (c.type === 'flat' && c.value % 100 !== 0) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Enter whole rupees' });
    }
    if (c.maxDiscount !== null && c.maxDiscount % 100 !== 0) {
      ctx.addIssue({ code: 'custom', path: ['maxDiscount'], message: 'Enter whole rupees' });
    }
    if (c.type !== 'percent' && c.maxDiscount !== null) {
      ctx.addIssue({ code: 'custom', path: ['maxDiscount'], message: 'Only percentage coupons have a maximum' });
    }
  });

const activeBody = z.object({ active: z.boolean() });

const toCoupon = (doc) => ({
  id: doc._id.toString(),
  code: doc.code,
  type: doc.type,
  value: doc.value,
  maxDiscount: doc.maxDiscount,
  minSubtotal: doc.minSubtotal,
  expiresAt: doc.expiresAt,
  usageLimit: doc.usageLimit,
  usedCount: doc.usedCount,
  active: doc.active,
  createdAt: doc.createdAt,
});

// Admins create coupons and switch them on or off. Never deleted: orders refer to them.
export function couponsRouter({ db }) {
  const coupons = db.collection('coupons');
  const router = express.Router();
  router.use('/admin/coupons', requireAdmin);

  router.get('/admin/coupons', async (req, res) => {
    const docs = await coupons.find().sort({ createdAt: -1, _id: -1 }).limit(500).toArray();
    res.json(docs.map(toCoupon));
  });

  router.post('/admin/coupons', async (req, res) => {
    const body = parse(couponBody, req.body);
    const doc = { ...body, usedCount: 0, active: true, createdAt: new Date() };
    try {
      const { insertedId } = await coupons.insertOne(doc);
      res.status(201).json(toCoupon({ ...doc, _id: insertedId }));
    } catch (err) {
      if (err.code === 11000) throw new HttpError(409, 'A coupon with this code already exists');
      throw err;
    }
  });

  router.patch('/admin/coupons/:id', async (req, res) => {
    const { active } = parse(activeBody, req.body);
    const doc = await coupons.findOneAndUpdate(
      { _id: parseObjectId(req.params.id, 'coupon id') },
      { $set: { active } },
      { returnDocument: 'after' },
    );
    if (!doc) throw new HttpError(404, 'Coupon not found');
    res.json(toCoupon(doc));
  });

  return router;
}
