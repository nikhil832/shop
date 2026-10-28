import express from 'express';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { HttpError, parse, parseObjectId } from './http.js';
import { logActivity, rupees } from './activity.js';

// Refused deliveries and Cash on Delivery limits (stage 79). A shipped order that comes back undelivered is cancelled
// as "returned to sender" (cancelOrder's `returned`: stock back, coupon and store credit given back, online payments
// refunded) with `returnedToSender` { reason (RTO_REASONS), note, at }. Cash on Delivery then has two rules, in
// `settings` { _id: 'cod', maxOrder (paise, or null for none), refusedLimit (or null) }: orders paying more than
// maxOrder on delivery must pay online, and so must a customer with refusedLimit COD orders returned for a reason that
// was theirs (COUNTED: refused or unreachable). An admin can forgive those (users.codForgivenAt: only later ones count).

export const RTO_REASONS = {
  refused: 'Refused by the customer',
  unreachable: 'Customer couldn’t be reached',
  address: 'Wrong or incomplete address',
  other: 'Something else',
};
const COUNTED = ['refused', 'unreachable'];
// No order-value limit until an admin sets one (switching one on by default would change live checkouts).
export const COD_DEFAULTS = { maxOrder: null, refusedLimit: 2 };
const SETTINGS = 'cod';

export async function codSettings(db) {
  const doc = await db.collection('settings').findOne({ _id: SETTINGS });
  return {
    maxOrder: doc && 'maxOrder' in doc ? doc.maxOrder : COD_DEFAULTS.maxOrder,
    refusedLimit: doc && 'refusedLimit' in doc ? doc.refusedLimit : COD_DEFAULTS.refusedLimit,
  };
}

// COD orders of `user` that came back for a reason that was theirs (since an admin last forgave them).
export const refusedCodOrders = (db, user) =>
  db.collection('orders').countDocuments({
    userId: user._id,
    'payment.method': 'cod',
    'returnedToSender.reason': { $in: COUNTED },
    ...(user.codForgivenAt && { 'returnedToSender.at': { $gt: user.codForgivenAt } }),
  });

// Whether `user` may pay `due` on delivery: { allowed, max, reason } (reason: why not, for the customer). Without
// `due`, only the customer's own record decides (checkout compares the amount itself).
export async function codAllowed(db, user, due) {
  const { maxOrder, refusedLimit } = await codSettings(db);
  if (user && refusedLimit !== null && (await refusedCodOrders(db, user)) >= refusedLimit) {
    return {
      allowed: false,
      max: maxOrder,
      reason: 'Some earlier Cash on Delivery orders came back undelivered, so please pay online.',
    };
  }
  if (due !== undefined && maxOrder !== null && due > maxOrder) {
    return {
      allowed: false,
      max: maxOrder,
      reason: `Cash on Delivery is for orders up to ${rupees(maxOrder)}; please pay online.`,
    };
  }
  return { allowed: true, max: maxOrder, reason: null };
}

const rule = z.number().int().min(0).nullable();
const settingsBody = z.object({
  // Paise, whole rupees from ₹100; null: no limit.
  maxOrder: rule.refine((n) => n === null || (n >= 10000 && n % 100 === 0), 'From ₹100, in whole rupees'),
  // 1 to 10 refused orders; null: never.
  refusedLimit: rule.refine((n) => n === null || (n >= 1 && n <= 10), 'From 1 to 10'),
});

export function codRouter({ db }) {
  const router = express.Router();
  router.use('/admin/cod', requireAdmin);

  router.get('/admin/cod', async (req, res) => {
    res.json(await codSettings(db));
  });

  router.put('/admin/cod', async (req, res) => {
    const body = parse(settingsBody, req.body);
    const before = await codSettings(db);
    await db.collection('settings').updateOne({ _id: SETTINGS }, { $set: body }, { upsert: true });
    const say = {
      maxOrder: (n) => (n === null ? 'No limit' : rupees(n)),
      refusedLimit: (n) => (n === null ? 'Never' : `After ${n}`),
    };
    const changes = [
      ['Cash on Delivery up to', 'maxOrder'],
      ['Pay online only', 'refusedLimit'],
    ]
      .filter(([, key]) => before[key] !== body[key])
      .map(([field, key]) => ({ field, from: say[key](before[key]), to: say[key](body[key]) }));
    if (changes.length) {
      await logActivity(db, req.user, {
        area: 'delivery',
        action: 'Changed Cash on Delivery rules',
        target: { label: 'Cash on Delivery', path: '/admin/delivery' },
        changes,
      });
    }
    res.json(body);
  });

  // Lets a customer pay on delivery again: only COD orders returned after this count against them.
  router.post('/admin/cod/forgive/:userId', async (req, res) => {
    const _id = parseObjectId(req.params.userId, 'customer id');
    const user = await db
      .collection('users')
      .findOneAndUpdate(
        { _id },
        { $set: { codForgivenAt: new Date() } },
        { returnDocument: 'after', projection: { name: 1 } },
      );
    if (!user) throw new HttpError(404, 'Customer not found');
    await logActivity(db, req.user, {
      area: 'accounts',
      action: 'Allowed Cash on Delivery again',
      target: { label: user.name, path: `/admin/customers/${_id}` },
    });
    res.status(204).end();
  });

  return router;
}
