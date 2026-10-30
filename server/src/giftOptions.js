import express from 'express';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { logActivity, rupees, yesNo } from './activity.js';
import { HttpError, parse } from './http.js';

// Gift options (stage 104): at checkout an order can be marked a gift, with a message for the packing slip and,
// when the store offers it, gift wrapping for a fee. The order keeps `gift` { message, wrap } and `giftWrap` (the fee
// paid, paise; absent when none), which is added after the discount: total = subtotal + delivery + giftWrap − discount.
// Like delivery it is never refunded by returns or item cancellations, is a line of its own on the GST invoice (at the
// delivery rate, as it goes with the goods) and appears wherever delivery does. Settings
// { _id: 'giftWrap', enabled, fee } in `settings`, off by default; Admin → Delivery changes them (logged).
const SETTINGS = 'giftWrap';
export const GIFT_DEFAULTS = { enabled: false, fee: 4900 };
export const MAX_MESSAGE = 200;

// What an order asks for: null when it isn't a gift.
export const giftBody = z
  .object({
    message: z.string().trim().max(MAX_MESSAGE, `A gift message can be at most ${MAX_MESSAGE} characters`).default(''),
    wrap: z.boolean().default(false),
  })
  .nullable()
  .default(null);

const settingsBody = z.object({
  enabled: z.boolean(),
  // Whole rupees, so bill lines add up.
  fee: z
    .number()
    .int()
    .min(100, 'At least ₹1')
    .max(50_000, 'At most ₹500')
    .refine((n) => n % 100 === 0, 'Whole rupees only'),
});

export async function giftSettings(db, session) {
  const doc = await db.collection('settings').findOne({ _id: SETTINGS }, { session });
  return { enabled: doc?.enabled ?? GIFT_DEFAULTS.enabled, fee: doc?.fee ?? GIFT_DEFAULTS.fee };
}

// The wrapping fee for this gift choice (0 for none), refusing wrapping the store doesn't offer.
export async function giftWrapFee(db, gift, session) {
  if (!gift?.wrap) return 0;
  const settings = await giftSettings(db, session);
  if (!settings.enabled) throw new HttpError(409, "Gift wrapping isn't available right now");
  return settings.fee;
}

export function giftOptionsRouter({ db }) {
  const router = express.Router();
  router.use('/admin/gift-wrap', requireAdmin);

  router.get('/admin/gift-wrap', async (req, res) => {
    res.json(await giftSettings(db));
  });

  router.put('/admin/gift-wrap', async (req, res) => {
    const body = parse(settingsBody, req.body);
    const before = await giftSettings(db);
    await db.collection('settings').updateOne({ _id: SETTINGS }, { $set: body }, { upsert: true });
    const changes = [
      ...(before.enabled !== body.enabled
        ? [{ field: 'Offered', from: yesNo(before.enabled), to: yesNo(body.enabled) }]
        : []),
      ...(before.fee !== body.fee ? [{ field: 'Fee', from: rupees(before.fee), to: rupees(body.fee) }] : []),
    ];
    if (changes.length) {
      await logActivity(db, req.user, {
        area: 'delivery',
        action: 'Changed gift wrapping',
        target: { label: 'Gift wrapping', path: '/admin/delivery' },
        changes,
      });
    }
    res.json(body);
  });

  return router;
}
