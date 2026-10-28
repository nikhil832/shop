import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { escapeRegex, HttpError, parse, parseObjectId } from './http.js';
import { logActivity, rupees } from './activity.js';
import { byOf, movedEntry, recordStock } from './stockHistory.js';

// Receiving stock (stage 81): a delivery from a supplier, recorded in one transaction: each line's stock goes up (the
// variant's and the product's total together), each is in the stock history as 'received', and, unless switched off,
// the cost price becomes the average of the stock on hand and the delivery (moving average; the delivery's own price
// when there was no cost or no stock). Collection `stockReceipts`:
// { number (counter 'receiptNumber', from 1, no gaps), supplier, reference, note, lines: [{ productId, variantId | null,
//   title (with the option), qty, unitCost | null, stockBefore, stockAfter, costBefore, costAfter }], updateCost,
//   by: { id, name }, createdAt }

export const MAX_LINES = 100;
const PAGE = 25;

const lineBody = z.object({
  productId: z.string().regex(/^[0-9a-f]{24}$/, 'Choose a product'),
  variantId: z
    .string()
    .regex(/^[0-9a-f]{24}$/)
    .optional(),
  qty: z.number('Enter how many').int().min(1, 'At least 1').max(10_000, 'At most 10,000'),
  // Paise each; none: not known (the cost price stays).
  unitCost: z.number().int().min(0).max(100_000_000).nullable().default(null),
});
const receiptBody = z.object({
  supplier: z.string().trim().min(1, 'Name the supplier').max(80),
  reference: z.string().trim().max(40).default(''),
  note: z.string().trim().max(500).default(''),
  lines: z
    .array(lineBody)
    .min(1, 'Add at least one product')
    .max(MAX_LINES, `At most ${MAX_LINES} lines`)
    .refine(
      (lines) => new Set(lines.map((l) => `${l.productId}.${l.variantId ?? ''}`)).size === lines.length,
      'Each product (and option) once',
    ),
  updateCost: z.boolean().default(true),
});
const listQuery = z.object({
  supplier: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

// The cost price after receiving `qty` at `unitCost` onto `stock` that cost `cost` each.
export function averageCost(stock, cost, qty, unitCost) {
  if (unitCost === null) return cost;
  if (cost === null || cost === undefined || stock <= 0) return unitCost;
  return Math.round((stock * cost + qty * unitCost) / (stock + qty));
}

const toReceipt = (doc) => ({
  id: doc._id.toString(),
  number: doc.number,
  supplier: doc.supplier,
  reference: doc.reference,
  note: doc.note,
  updateCost: doc.updateCost,
  lines: doc.lines.map((l) => ({
    ...l,
    productId: l.productId.toString(),
    variantId: l.variantId?.toString() ?? null,
  })),
  units: doc.lines.reduce((n, l) => n + l.qty, 0),
  value: doc.lines.every((l) => l.unitCost !== null) ? doc.lines.reduce((s, l) => s + l.qty * l.unitCost, 0) : null,
  by: doc.by.name,
  createdAt: doc.createdAt,
});

export function stockReceiptsRouter({ db, client }) {
  const receipts = db.collection('stockReceipts');
  const products = db.collection('products');
  const router = express.Router();
  router.use('/admin/stock-receipts', requireAdmin);

  // Newest first, optionally one supplier's; `suppliers` (every name used) fills the form's suggestions.
  router.get('/admin/stock-receipts', async (req, res) => {
    const query = parse(listQuery, req.query);
    const filter = query.supplier ? { supplier: { $regex: `^${escapeRegex(query.supplier)}$`, $options: 'i' } } : {};
    const [docs, total, suppliers] = await Promise.all([
      receipts
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * PAGE)
        .limit(PAGE)
        .toArray(),
      receipts.countDocuments(filter),
      receipts.distinct('supplier'),
    ]);
    res.json({ items: docs.map(toReceipt), total, page: query.page, pageSize: PAGE, suppliers: suppliers.sort() });
  });

  router.get('/admin/stock-receipts/:id', async (req, res) => {
    const doc = await receipts.findOne({ _id: parseObjectId(req.params.id, 'receipt id') });
    if (!doc) throw new HttpError(404, 'Delivery not found');
    res.json(toReceipt(doc));
  });

  router.post('/admin/stock-receipts', async (req, res) => {
    const body = parse(receiptBody, req.body);
    const session = client.startSession();
    let receipt;
    try {
      await session.withTransaction(async () => {
        const now = new Date();
        const counter = await db
          .collection('counters')
          .findOneAndUpdate(
            { _id: 'receiptNumber' },
            { $inc: { seq: 1 } },
            { session, upsert: true, returnDocument: 'after' },
          );
        const _id = new ObjectId();
        const lines = [];
        const entries = [];
        for (const line of body.lines) {
          const productId = new ObjectId(line.productId);
          const variantId = line.variantId ? new ObjectId(line.variantId) : null;
          // Read in the transaction, so an order taking stock meanwhile makes it start again with the new numbers.
          const product = await products.findOne({ _id: productId }, { session });
          if (!product) throw new HttpError(400, 'lines: A product no longer exists');
          const variant = variantId && product.variants?.find((v) => v._id.equals(variantId));
          if (variantId && !variant) throw new HttpError(400, `lines: ${product.title} has no such option`);
          if (!variantId && product.variants?.length) {
            throw new HttpError(400, `lines: Choose which ${product.variantName.toLowerCase()} of ${product.title}`);
          }
          const own = variant ?? product;
          const costBefore = own.cost ?? null;
          const costAfter = body.updateCost ? averageCost(own.stock, costBefore, line.qty, line.unitCost) : costBefore;
          const after = await products.findOneAndUpdate(
            variant ? { _id: productId, 'variants._id': variantId } : { _id: productId },
            {
              $inc: variant ? { stock: line.qty, 'variants.$.stock': line.qty } : { stock: line.qty },
              $set: {
                updatedAt: now,
                ...(costAfter !== costBefore && { [variant ? 'variants.$.cost' : 'cost']: costAfter }),
              },
            },
            { session, returnDocument: 'after' },
          );
          entries.push(
            movedEntry(after, variantId, line.qty, {
              reason: 'received',
              receiptId: _id,
              receiptNumber: counter.seq,
              by: byOf(req.user),
              at: now,
            }),
          );
          lines.push({
            productId,
            variantId,
            title: variant ? `${product.title} (${variant.label})` : product.title,
            qty: line.qty,
            unitCost: line.unitCost,
            stockBefore: own.stock,
            stockAfter: own.stock + line.qty,
            costBefore,
            costAfter,
          });
        }
        receipt = {
          _id,
          number: counter.seq,
          supplier: body.supplier,
          reference: body.reference,
          note: body.note,
          lines,
          updateCost: body.updateCost,
          by: byOf(req.user),
          createdAt: now,
        };
        await receipts.insertOne(receipt, { session });
        await recordStock(db, entries, session);
      });
    } finally {
      await session.endSession();
    }
    await logActivity(db, req.user, {
      area: 'products',
      action: 'Received stock',
      target: {
        label: `Delivery #${receipt.number} from ${receipt.supplier}`,
        path: `/admin/stock-receipts/${receipt._id}`,
      },
      changes: receipt.lines.map((l) => ({
        field: l.title,
        to: `+${l.qty}${l.unitCost !== null ? ` at ${rupees(l.unitCost)}` : ''}${l.costAfter !== l.costBefore ? `, cost now ${rupees(l.costAfter)}` : ''}`,
      })),
    });
    res.status(201).json(toReceipt(receipt));
  });

  return router;
}
