import express from 'express';
import { z } from 'zod';
import { HttpError, parse, parseObjectId } from './http.js';
import { requirePermission } from './staff.js';

// Stock history (stage 70, collection `stockHistory`): every change to a product's or a variant's stock, with why,
// written in the same transaction as the change itself, so the list can't miss one or show one that didn't happen:
// { productId, variantId: ObjectId | null, label (the variant's, or null for the product's own stock), change,
//   after (that stock once changed), reason (REASONS), orderId?, orderNumber?, returnId?, exchangeId?, receiptId?,
//   receiptNumber?, stocktakeId?, stocktakeNumber?, by: { id, name } | null, at }
// A product with variants has entries per variant only: its own stock is their sum. Entries go after HISTORY_DAYS.

export const HISTORY_DAYS = 365;
export const HISTORY_PAGE = 50;
export const REASONS = {
  ordered: 'Ordered',
  cancelled: 'Cancelled by the customer',
  store_cancelled: 'Cancelled by the store',
  released: 'Unpaid order released',
  returned_to_sender: 'Returned to sender',
  received: 'Received',
  // Put right by a stocktake (stocktakes.js).
  counted: 'Stocktake',
  returned: 'Return approved',
  // Exchanges (stage 89): the new option set aside when asked, given back when declined or called off, and the
  // customer's item back when approved.
  exchange_reserved: 'Set aside for an exchange',
  exchange_released: 'Exchange called off',
  exchange_returned: 'Exchanged item back',
  edited: 'Changed by hand',
  imported: 'CSV import',
  added: 'Product added',
};
// cancelOrder's `by` → reason. 'system' cancels orders nobody paid for (expired, or Razorpay refused at checkout).
export const CANCEL_REASONS = { customer: 'cancelled', admin: 'store_cancelled', system: 'released' };

export const byOf = (user) => (user ? { id: user._id, name: user.name } : null);

// The entry for one $inc on a product, from the product as it is after the change (findOneAndUpdate's 'after').
export function movedEntry(after, variantId, change, extra) {
  const variant = variantId && after.variants?.find((v) => v._id.equals(variantId));
  return {
    productId: after._id,
    variantId: variant ? variant._id : null,
    label: variant ? variant.label : null,
    change,
    after: variant ? variant.stock : after.stock,
    ...extra,
  };
}

// The entries for a product saved whole (an admin edit, a CSV import, a new product): before (null for a new one)
// against after. Variants are matched by id; one removed leaves with its stock, a product switched to or from
// variants moves its own stock to or from 0.
export function savedEntries(before, after, extra) {
  const entries = [];
  const add = (variant, from, to) => {
    if (to !== from) {
      entries.push({
        productId: after._id,
        variantId: variant?._id ?? null,
        label: variant?.label ?? null,
        change: to - from,
        after: to,
        ...extra,
      });
    }
  };
  const hadVariants = Boolean(before?.variants?.length);
  const hasVariants = Boolean(after.variants?.length);
  if (!hadVariants && !hasVariants) return (add(null, before?.stock ?? 0, after.stock), entries);
  if (!hadVariants) add(null, before?.stock ?? 0, 0);
  const old = new Map((before?.variants ?? []).map((v) => [v._id.toString(), v]));
  for (const v of after.variants ?? []) {
    add(v, old.get(v._id.toString())?.stock ?? 0, v.stock);
    old.delete(v._id.toString());
  }
  for (const v of old.values()) add(v, v.stock, 0);
  if (!hasVariants) add(null, 0, after.stock);
  return entries;
}

export async function recordStock(db, entries, session) {
  if (entries.length) await db.collection('stockHistory').insertMany(entries, { session });
}

const historyQuery = z.object({
  // A variant's id, or "product" for a product's own stock.
  variant: z
    .string()
    .regex(/^([0-9a-f]{24}|product)$/, 'Choose a variant')
    .optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

const toEntry = (doc) => ({
  id: doc._id.toString(),
  at: doc.at,
  label: doc.label,
  change: doc.change,
  after: doc.after,
  reason: doc.reason,
  order: doc.orderId ? { id: doc.orderId.toString(), number: doc.orderNumber ?? null } : null,
  returnId: doc.returnId?.toString() ?? null,
  exchangeId: doc.exchangeId?.toString() ?? null,
  // A delivery from a supplier (stockReceipts.js).
  receipt: doc.receiptId ? { id: doc.receiptId.toString(), number: doc.receiptNumber } : null,
  // A stocktake that put the stock right (stocktakes.js).
  stocktake: doc.stocktakeId ? { id: doc.stocktakeId.toString(), number: doc.stocktakeNumber } : null,
  by: doc.by?.name ?? null,
});

export function stockHistoryRouter({ db }) {
  const router = express.Router();

  // Admins and packers (who count the shelves).
  router.get('/admin/products/:id/stock-history', requirePermission('stock.history'), async (req, res) => {
    const _id = parseObjectId(req.params.id, 'product id');
    const { variant, page } = parse(historyQuery, req.query);
    const product = await db.collection('products').findOne({ _id });
    if (!product) throw new HttpError(404, 'Product not found');
    const filter = { productId: _id };
    if (variant) filter.variantId = variant === 'product' ? null : parseObjectId(variant, 'variant');
    const history = db.collection('stockHistory');
    const [items, total] = await Promise.all([
      history
        .find(filter)
        .sort({ at: -1, _id: -1 })
        .skip((page - 1) * HISTORY_PAGE)
        .limit(HISTORY_PAGE)
        .toArray(),
      history.countDocuments(filter),
    ]);
    res.json({
      product: {
        id: product._id.toString(),
        title: product.title,
        slug: product.slug,
        stock: product.stock,
        variants: (product.variants ?? []).map((v) => ({ id: v._id.toString(), label: v.label, stock: v.stock })),
      },
      items: items.map(toEntry),
      total,
      page,
      pageSize: HISTORY_PAGE,
    });
  });

  return router;
}
