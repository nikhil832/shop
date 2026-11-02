import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { HttpError, parse } from './http.js';
import { logActivity, rupees } from './activity.js';
import { imageFor } from './variants.js';
import { movedEntry } from './stockHistory.js';

// A free gift with orders over an amount (stage 149). One offer at a time, in `settings` { _id: 'freeGift', enabled,
// productId, minSubtotal (paise, whole rupees), from, to ('YYYY-MM-DD' India-time days, both included, or null) }.
// The gift is a shown product without options. An order whose items come to minSubtotal or more (after bundle and
// quantity savings, before coupons: like free delivery) gets one as its own item at price 0 with `freeGift: true`,
// `regularPrice` and a title ending "(free gift)", so emails, invoices, slips and exports need nothing else; its stock
// is taken in the order's transaction (with a stock history entry). If none is left, the order goes ahead without it.
// The cart quote says how far the customer is from it. Admins only; logged in area `coupons`.

const SETTINGS = 'freeGift';
export const DEFAULTS = { enabled: false, productId: null, minSubtotal: 99900, from: null, to: null };
export const GIFT_SUFFIX = ' (free gift)';
const MAX_MIN = 10000000; // ₹1,00,000

// Today in India, as 'YYYY-MM-DD'.
const istDay = (now) => new Date(now.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);

export async function freeGiftSettings(db, session) {
  const doc = await db.collection('settings').findOne({ _id: SETTINGS }, { session });
  return { ...DEFAULTS, ...(doc && { ...doc, _id: undefined }) };
}

// The offer now: { minSubtotal, product (the document, maybe with no stock) }, or null when off, outside its days, or
// its product is hidden or has options.
export async function liveFreeGift(db, now = new Date(), session) {
  const s = await freeGiftSettings(db, session);
  if (!s.enabled || !s.productId) return null;
  const today = istDay(now);
  if ((s.from && today < s.from) || (s.to && today > s.to)) return null;
  const product = await db
    .collection('products')
    .findOne({ _id: s.productId, active: true, 'variants.0': { $exists: false } }, { session });
  return product ? { minSubtotal: s.minSubtotal, product } : null;
}

// Inside an order's transaction: takes one unit of the gift and returns { item, moved } for an order whose items come
// to `subtotal`, or null (no offer, not enough, or none left).
export async function takeFreeGift(db, { subtotal, gst, now, session }) {
  const offer = await liveFreeGift(db, now, session);
  if (!offer || subtotal < offer.minSubtotal) return null;
  const doc = await db
    .collection('products')
    .findOneAndUpdate(
      { _id: offer.product._id, active: true, stock: { $gte: 1 }, 'variants.0': { $exists: false } },
      { $inc: { stock: -1 }, $set: { updatedAt: now } },
      { session, returnDocument: 'after' },
    );
  if (!doc) return null;
  return {
    moved: movedEntry(doc, null, -1, { reason: 'ordered', by: null, at: now }),
    item: {
      productId: doc._id,
      slug: doc.slug,
      title: `${doc.title}${GIFT_SUFFIX}`,
      brand: doc.brand,
      image: imageFor(doc, null),
      price: 0,
      regularPrice: doc.price,
      freeGift: true,
      // What it cost the store (stage 80) counts against profit like any item.
      ...(doc.cost != null && { cost: doc.cost }),
      ...(doc.sku && { sku: doc.sku }),
      qty: 1,
      ...(gst && { gstRate: gst.forCategory(doc.categoryId).rate, hsn: gst.forCategory(doc.categoryId).hsn }),
    },
  };
}

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date')
  .refine(
    (d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d),
    'Use a real date',
  )
  .nullable();
const settingsBody = z
  .object({
    enabled: z.boolean(),
    productId: z
      .string()
      .regex(/^[0-9a-f]{24}$/, 'Choose a product')
      .nullable(),
    minSubtotal: z
      .number()
      .int()
      .min(100, 'From ₹1')
      .max(MAX_MIN, 'At most ₹1,00,000')
      .refine((n) => n % 100 === 0, 'In whole rupees'),
    from: day,
    to: day,
  })
  .superRefine((b, ctx) => {
    if (b.enabled && !b.productId) ctx.addIssue({ code: 'custom', path: ['productId'], message: 'Choose a product' });
    if (b.from && b.to && b.to < b.from) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'The last day is before the first' });
    }
  });

export function freeGiftRouter({ db }) {
  const router = express.Router();
  router.use('/admin/free-gift', requireAdmin);
  const products = db.collection('products');

  router.get('/admin/free-gift', async (req, res) => {
    const s = await freeGiftSettings(db);
    const [choices, given] = await Promise.all([
      // Products that can be a gift: shown, without options.
      products
        .find({ active: true, 'variants.0': { $exists: false } }, { projection: { title: 1, stock: 1 } })
        .sort({ title: 1 })
        .limit(500)
        .toArray(),
      db.collection('orders').countDocuments({ 'items.freeGift': true, status: { $ne: 'cancelled' } }),
    ]);
    const live = await liveFreeGift(db);
    res.json({
      enabled: s.enabled,
      productId: s.productId?.toString() ?? null,
      minSubtotal: s.minSubtotal,
      from: s.from,
      to: s.to,
      // Whether customers see it right now (on, within its days, the product shown) and how many are left.
      live: Boolean(live),
      stock: live?.product.stock ?? null,
      given,
      choices: choices.map((p) => ({ id: p._id.toString(), title: p.title, stock: p.stock })),
    });
  });

  router.put('/admin/free-gift', async (req, res) => {
    const body = parse(settingsBody, req.body);
    const productId = body.productId ? new ObjectId(body.productId) : null;
    let product = null;
    if (productId) {
      product = await products.findOne({ _id: productId }, { projection: { title: 1, active: 1, variants: 1 } });
      if (!product) throw new HttpError(400, 'productId: That product no longer exists');
      if (product.variants?.length) throw new HttpError(400, 'productId: Choose a product without options');
      if (body.enabled && !product.active) throw new HttpError(400, 'productId: That product is hidden');
    }
    const before = await freeGiftSettings(db);
    const next = { ...body, productId };
    await db.collection('settings').updateOne({ _id: SETTINGS }, { $set: next }, { upsert: true });
    const titleOf = async (id) =>
      id ? ((await products.findOne({ _id: id }, { projection: { title: 1 } }))?.title ?? 'A deleted product') : 'None';
    const changes = [];
    if (before.enabled !== next.enabled)
      changes.push({ field: 'Free gift', from: before.enabled ? 'On' : 'Off', to: next.enabled ? 'On' : 'Off' });
    if (String(before.productId) !== String(next.productId)) {
      changes.push({ field: 'Gift', from: await titleOf(before.productId), to: product?.title ?? 'None' });
    }
    if (before.minSubtotal !== next.minSubtotal) {
      changes.push({ field: 'Orders from', from: rupees(before.minSubtotal), to: rupees(next.minSubtotal) });
    }
    const days = (s) => (s.from || s.to ? `${s.from ?? 'now'} to ${s.to ?? 'no end'}` : 'Always');
    if (days(before) !== days(next)) changes.push({ field: 'Days', from: days(before), to: days(next) });
    if (changes.length) {
      await logActivity(db, req.user, {
        area: 'coupons',
        action: 'Changed the free gift',
        target: { label: 'Free gift', path: '/admin/coupons' },
        changes,
      });
    }
    res.json({ ...next, productId: body.productId });
  });

  return router;
}
