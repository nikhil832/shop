// "New" and "Bestseller" badges on product cards and pages (stage 150). Imports nothing of the store's, as
// routes/catalog.js (toProductCard) imports it.
//
// New: shown in the shop for the first time within NEW_DAYS. `products.firstShownAt` is set when a product is first
// shown (admin create or a hidden product shown, the CSV import likewise), so a product drafted hidden for weeks still
// gets its days and the sample catalog (which has none) isn't all "new".
//
// Bestseller: each category's top BEST_PER_CATEGORY products by units sold in sold orders of the last BEST_DAYS, with
// at least MIN_UNITS units to at least MIN_CUSTOMERS customers (so one big basket isn't a bestseller). Free gifts
// (price 0) don't count. Worked out by refreshBadges() from the minute sweep (and at startup), kept in memory, as
// toProductCard is synchronous and called everywhere; one store per server process.

export const NEW_DAYS = 30;
export const BEST_DAYS = 30;
export const BEST_PER_CATEGORY = 3;
export const MIN_UNITS = 3;
export const MIN_CUSTOMERS = 2;
const DAY = 24 * 60 * 60 * 1000;
const SOLD = ['placed', 'shipped', 'delivered']; // dashboard.js's, copied: it leads back here through catalog.js

let bestsellers = new Set();

export async function refreshBadges(db, now = new Date()) {
  const rows = await db
    .collection('orders')
    .aggregate([
      { $match: { status: { $in: SOLD }, createdAt: { $gte: new Date(now.getTime() - BEST_DAYS * DAY) } } },
      { $unwind: '$items' },
      { $match: { 'items.price': { $gt: 0 } } },
      { $group: { _id: '$items.productId', units: { $sum: '$items.qty' }, customers: { $addToSet: '$userId' } } },
      { $match: { units: { $gte: MIN_UNITS } } },
      { $project: { units: 1, customers: { $size: '$customers' } } },
      { $match: { customers: { $gte: MIN_CUSTOMERS } } },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'product',
          pipeline: [{ $match: { active: true } }, { $project: { categoryId: 1 } }],
        },
      },
      { $unwind: '$product' },
      { $sort: { units: -1, customers: -1, _id: 1 } },
      { $group: { _id: '$product.categoryId', top: { $push: '$_id' } } },
      { $project: { top: { $slice: ['$top', BEST_PER_CATEGORY] } } },
    ])
    .toArray();
  bestsellers = new Set(rows.flatMap((r) => r.top.map((id) => id.toString())));
  return bestsellers.size;
}

// 'bestseller', 'new' or null for a product document (a bestseller is shown as that, even when new).
export function badgeOf(doc, now = Date.now()) {
  if (bestsellers.has(doc._id.toString())) return 'bestseller';
  if (doc.firstShownAt && now - doc.firstShownAt.getTime() < NEW_DAYS * DAY) return 'new';
  return null;
}
