// Loyalty levels (stage 134): Silver and Gold by what a customer spent on kept (delivered) orders in the last
// LOYALTY_DAYS, less refunds of their returns. Each level's perk is a lower free-delivery minimum (0: free delivery
// on every order), used by the cart quote and POST /orders. `settings` { _id: 'loyalty', enabled, silver: { spend,
// freeDeliveryMin }, gold: { … } } in paise; off until an admin switches it on. Nothing is stored per customer: the
// level is worked out when needed, so it follows their orders (and drops a year after them). Imports nothing of the
// store's, as orders.js uses it (routes/loyalty.js has the admin and account routes).
export const LOYALTY_DAYS = 365;
export const LEVELS = { silver: 'Silver', gold: 'Gold' };
export const DEFAULTS = {
  enabled: false,
  silver: { spend: 500000, freeDeliveryMin: 29900 },
  gold: { spend: 2000000, freeDeliveryMin: 0 },
};
const SETTINGS = 'loyalty';
// The same as REFUNDED_RETURNS in routes/dashboard.js (not imported: it leads back to orders.js).
const REFUNDED_RETURNS = ['approved', 'refunding', 'refunded', 'refund_failed'];
const DAY = 86_400_000;

export async function loyaltySettings(db) {
  const doc = await db.collection('settings').findOne({ _id: SETTINGS });
  return { ...DEFAULTS, ...doc };
}
export const saveLoyaltySettings = (db, s) =>
  db.collection('settings').updateOne({ _id: SETTINGS }, { $set: s }, { upsert: true });

// What `userId` spent on orders delivered in the last LOYALTY_DAYS, less refunds of their returns (paise).
export async function spentInYear(db, userId, now = new Date()) {
  const orders = await db
    .collection('orders')
    .find(
      { userId, status: 'delivered', deliveredAt: { $gte: new Date(now - LOYALTY_DAYS * DAY) } },
      { projection: { total: 1 } },
    )
    .toArray();
  if (!orders.length) return 0;
  const [refunds] = await db
    .collection('returns')
    .aggregate([
      { $match: { orderId: { $in: orders.map((o) => o._id) }, status: { $in: REFUNDED_RETURNS } } },
      { $group: { _id: null, total: { $sum: '$refund' } } },
    ])
    .toArray();
  return Math.max(0, orders.reduce((sum, o) => sum + o.total, 0) - (refunds?.total ?? 0));
}

// A customer's level: { level, label, spent, freeDeliveryMin, next: { level, label, needed } | null }, with `level`
// null below Silver; null altogether when loyalty is off or there's no customer.
export async function loyaltyFor(db, userId, now = new Date()) {
  if (!userId) return null;
  const s = await loyaltySettings(db);
  if (!s.enabled) return null;
  const spent = await spentInYear(db, userId, now);
  const level = spent >= s.gold.spend ? 'gold' : spent >= s.silver.spend ? 'silver' : null;
  const nextLevel = level === null ? 'silver' : level === 'silver' ? 'gold' : null;
  return {
    level,
    label: level ? LEVELS[level] : null,
    spent,
    freeDeliveryMin: level ? s[level].freeDeliveryMin : null,
    next: nextLevel
      ? {
          level: nextLevel,
          label: LEVELS[nextLevel],
          needed: s[nextLevel].spend - spent,
          freeDeliveryMin: s[nextLevel].freeDeliveryMin,
        }
      : null,
  };
}
