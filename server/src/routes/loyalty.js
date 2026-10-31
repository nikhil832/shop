import express from 'express';
import { z } from 'zod';
import { requireAdmin, requireUser } from '../auth.js';
import { logActivity, rupees } from '../activity.js';
import { parse } from '../http.js';
import { LEVELS, loyaltyFor, loyaltySettings, saveLoyaltySettings } from '../loyalty.js';
import { FREE_DELIVERY_MIN } from './orders.js';

// Loyalty levels (stage 134, loyalty.js): the customer's own level for the account page, and the admin's settings
// (on Admin → Coupons, logged in area `coupons`).
const wholeRupees = (what) =>
  z
    .number()
    .int()
    .min(0, `${what} can't be negative`)
    .max(100_000_000)
    .refine((v) => v % 100 === 0, `${what}: use whole rupees`);
const level = z.object({
  spend: wholeRupees('The spend').refine((v) => v >= 100, 'Set a spend of at least ₹1'),
  freeDeliveryMin: wholeRupees('The free-delivery minimum').refine(
    (v) => v <= FREE_DELIVERY_MIN,
    `The free-delivery minimum can't be above the usual ${rupees(FREE_DELIVERY_MIN)}`,
  ),
});
const settingsBody = z
  .object({ enabled: z.boolean(), silver: level, gold: level })
  .refine((s) => s.gold.spend > s.silver.spend, { message: 'Gold must need more spending than Silver' })
  .refine((s) => s.gold.freeDeliveryMin <= s.silver.freeDeliveryMin, {
    message: "Gold's free-delivery minimum must be no higher than Silver's",
  });

const levelText = (l) =>
  `from ${rupees(l.spend)}, free delivery ${l.freeDeliveryMin ? `from ${rupees(l.freeDeliveryMin)}` : 'always'}`;

export function loyaltyRouter({ db }) {
  const router = express.Router();

  // The account page's "Your level": null when loyalty is off.
  router.get('/account/loyalty', requireUser, async (req, res) => {
    const mine = await loyaltyFor(db, req.user._id);
    const s = await loyaltySettings(db);
    res.json({ loyalty: mine, levels: s.enabled ? { silver: s.silver, gold: s.gold } : null });
  });

  router.get('/admin/loyalty', requireAdmin, async (req, res) => {
    const s = await loyaltySettings(db);
    res.json({ enabled: s.enabled, silver: s.silver, gold: s.gold, usualFreeDeliveryMin: FREE_DELIVERY_MIN });
  });

  router.put('/admin/loyalty', requireAdmin, async (req, res) => {
    const body = parse(settingsBody, req.body);
    const before = await loyaltySettings(db);
    await saveLoyaltySettings(db, body);
    const changes = [
      ['On', before.enabled ? 'yes' : 'no', body.enabled ? 'yes' : 'no'],
      [LEVELS.silver, levelText(before.silver), levelText(body.silver)],
      [LEVELS.gold, levelText(before.gold), levelText(body.gold)],
    ]
      .filter(([, from, to]) => from !== to)
      .map(([field, from, to]) => ({ field, from, to }));
    if (changes.length) {
      await logActivity(db, req.user, {
        area: 'coupons',
        action: 'Changed loyalty levels',
        target: { label: 'Loyalty levels', path: '/admin/coupons' },
        changes,
      });
    }
    res.json(body);
  });

  return router;
}
