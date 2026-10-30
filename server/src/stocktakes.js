import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { HttpError, parse, parseObjectId } from './http.js';
import { logActivity } from './activity.js';
import { byOf, movedEntry, recordStock } from './stockHistory.js';

// Stocktake (stage 98): counting what is on the shelves and putting the database right. The store takes stock off
// when an order is placed, not when it ships, so the shelves also hold everything sold but not yet sent: units in
// orders still `awaiting_payment` or `placed`, and options set aside for exchanges still `requested` or `approved`.
// "On the shelf" is therefore stock + those reserved units, and a count of N sets stock to N − reserved (never below
// 0; a count below the reserved units is `short`: orders that can't all be filled). A product with options is counted
// per option. Saving recomputes everything in one transaction (an order meanwhile makes it start again) and records
// each change in the stock history as 'counted'; uncounted rows stay as they are. Admins only.
// Collection `stocktakes`: { number (counter 'stocktakeNumber', in the transaction), categoryId | null, categoryName,
//   note, lines: [{ productId, variantId | null, title (with the option), reserved, onShelf, counted, stockBefore,
//   stockAfter, short }], by: { id, name }, createdAt }
export const MAX_ROWS = 1000;
const PAGE = 25;
// Orders and exchanges whose units have left the stock figure but not the shelf.
const UNSHIPPED_ORDERS = ['awaiting_payment', 'placed'];
const UNSHIPPED_EXCHANGES = ['requested', 'approved'];

const objectId = (message) => z.string().regex(/^[0-9a-f]{24}$/, message);
const sheetQuery = z.object({ category: objectId('Choose a category').optional() });
const countBody = z.object({
  category: objectId('Choose a category').nullable().default(null),
  note: z.string().trim().max(500).default(''),
  lines: z
    .array(
      z.object({
        productId: objectId('Invalid product'),
        variantId: objectId('Invalid option').optional(),
        counted: z.number('Enter a number').int('Whole numbers only').min(0, 'At least 0').max(100_000),
      }),
    )
    .min(1, 'Enter at least one count')
    .max(MAX_ROWS)
    .refine(
      (lines) => new Set(lines.map((l) => `${l.productId}.${l.variantId ?? ''}`)).size === lines.length,
      'Each product (and option) once',
    ),
  // Only show the differences, saving nothing.
  preview: z.boolean().default(false),
});
const listQuery = z.object({ page: z.coerce.number().int().min(1).max(1000).default(1) });

const key = (productId, variantId) => `${productId}.${variantId ?? ''}`;

// Units sold or set aside but still on the shelf, by key(productId, variantId), for these products (all if null).
async function reservedUnits(db, productIds, session) {
  const match = productIds ? { $in: productIds } : { $exists: true };
  const [ordered, exchanged] = await Promise.all([
    db
      .collection('orders')
      .aggregate(
        [
          { $match: { status: { $in: UNSHIPPED_ORDERS } } },
          { $unwind: '$items' },
          { $match: { 'items.productId': match } },
          { $group: { _id: { p: '$items.productId', v: '$items.variantId' }, qty: { $sum: '$items.qty' } } },
        ],
        { session },
      )
      .toArray(),
    db
      .collection('exchanges')
      .aggregate(
        [
          { $match: { status: { $in: UNSHIPPED_EXCHANGES } } },
          { $unwind: '$items' },
          { $match: { 'items.productId': match } },
          { $group: { _id: { p: '$items.productId', v: '$items.toVariantId' }, qty: { $sum: '$items.qty' } } },
        ],
        { session },
      )
      .toArray(),
  ]);
  const reserved = new Map();
  for (const r of [...ordered, ...exchanged]) {
    const k = key(r._id.p, r._id.v);
    reserved.set(k, (reserved.get(k) ?? 0) + r.qty);
  }
  return reserved;
}

// One row per product without options, or per option: what the database says is on the shelf.
function sheetRows(products, reserved) {
  const rows = [];
  for (const p of products) {
    const own = (variant) => {
      const stock = (variant ?? p).stock;
      const held = reserved.get(key(p._id, variant?._id)) ?? 0;
      return {
        productId: p._id.toString(),
        variantId: variant?._id.toString() ?? null,
        title: p.title,
        label: variant?.label ?? null,
        active: p.active !== false,
        stock,
        reserved: held,
        onShelf: stock + held,
      };
    };
    if (p.variants?.length) for (const v of p.variants) rows.push(own(v));
    else rows.push(own(null));
  }
  return rows;
}

// A count against what's on the shelf: the stock it leaves.
const settle = (row, counted) => {
  const stockAfter = Math.max(0, counted - row.reserved);
  return { counted, difference: counted - row.onShelf, stockAfter, short: Math.max(0, row.reserved - counted) };
};

const toStocktake = (doc) => ({
  id: doc._id.toString(),
  number: doc.number,
  category: doc.categoryId ? { id: doc.categoryId.toString(), name: doc.categoryName } : null,
  note: doc.note,
  lines: doc.lines.map((l) => ({
    ...l,
    productId: l.productId.toString(),
    variantId: l.variantId?.toString() ?? null,
    difference: l.counted - l.onShelf,
  })),
  counted: doc.lines.length,
  changed: doc.lines.filter((l) => l.stockAfter !== l.stockBefore).length,
  // Units found (positive) or missing (negative) against what should have been on the shelf.
  difference: doc.lines.reduce((n, l) => n + l.counted - l.onShelf, 0),
  by: doc.by.name,
  createdAt: doc.createdAt,
});

export function stocktakesRouter({ db, client }) {
  const stocktakes = db.collection('stocktakes');
  const products = db.collection('products');
  const router = express.Router();
  router.use('/admin/stocktakes', requireAdmin);

  async function categoryOf(id) {
    if (!id) return null;
    const category = await db.collection('categories').findOne({ _id: new ObjectId(id) });
    if (!category) throw new HttpError(404, 'Category not found');
    return category;
  }

  router.get('/admin/stocktakes', async (req, res) => {
    const { page } = parse(listQuery, req.query);
    const [docs, total] = await Promise.all([
      stocktakes
        .find()
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * PAGE)
        .limit(PAGE)
        .toArray(),
      stocktakes.countDocuments(),
    ]);
    res.json({ items: docs.map(toStocktake), total, page, pageSize: PAGE });
  });

  // The count sheet: every product of the category (or the store), shown or hidden, by title.
  router.get('/admin/stocktakes/sheet', async (req, res) => {
    const query = parse(sheetQuery, req.query);
    const category = await categoryOf(query.category);
    const list = await products
      .find(category ? { categoryId: category._id } : {}, {
        projection: { title: 1, active: 1, stock: 1, variants: 1 },
      })
      .sort({ title: 1, _id: 1 })
      .toArray();
    const rows = sheetRows(list, await reservedUnits(db, null));
    if (rows.length > MAX_ROWS) throw new HttpError(400, `More than ${MAX_ROWS} rows: count one category at a time`);
    res.json({ category: category ? { id: category._id.toString(), name: category.name } : null, rows });
  });

  router.get('/admin/stocktakes/:id', async (req, res) => {
    const doc = await stocktakes.findOne({ _id: parseObjectId(req.params.id, 'stocktake id') });
    if (!doc) throw new HttpError(404, 'Stocktake not found');
    res.json(toStocktake(doc));
  });

  // Checks (preview) or saves a count. Each line is matched to its sheet row as it is now.
  router.post('/admin/stocktakes', async (req, res) => {
    const body = parse(countBody, req.body);
    const category = await categoryOf(body.category);
    const ids = [...new Set(body.lines.map((l) => l.productId))].map((id) => new ObjectId(id));

    // Rows for the counted lines, read (in `session` when saving) as they are now.
    async function countedRows(session) {
      const list = await products
        .find({ _id: { $in: ids } }, { session, projection: { title: 1, active: 1, stock: 1, variants: 1 } })
        .toArray();
      const rows = new Map(
        sheetRows(list, await reservedUnits(db, ids, session)).map((r) => [key(r.productId, r.variantId), r]),
      );
      return body.lines.map((line) => {
        const row = rows.get(key(line.productId, line.variantId));
        if (!row) {
          const product = list.find((p) => p._id.toString() === line.productId);
          if (!product) throw new HttpError(400, 'lines: A product no longer exists');
          throw new HttpError(
            400,
            line.variantId
              ? `lines: ${product.title} has no such option`
              : `lines: Count ${product.title} by its options`,
          );
        }
        return { ...row, ...settle(row, line.counted) };
      });
    }

    if (body.preview) {
      const rows = await countedRows();
      return res.json({
        preview: {
          rows,
          changed: rows.filter((r) => r.stockAfter !== r.stock).length,
          difference: rows.reduce((n, r) => n + r.difference, 0),
        },
      });
    }

    const session = client.startSession();
    let doc;
    try {
      await session.withTransaction(async () => {
        const now = new Date();
        const rows = await countedRows(session);
        const counter = await db
          .collection('counters')
          .findOneAndUpdate(
            { _id: 'stocktakeNumber' },
            { $inc: { seq: 1 } },
            { session, upsert: true, returnDocument: 'after' },
          );
        const _id = new ObjectId();
        const entries = [];
        for (const r of rows) {
          const change = r.stockAfter - r.stock;
          if (!change) continue;
          const productId = new ObjectId(r.productId);
          const variantId = r.variantId ? new ObjectId(r.variantId) : null;
          // The variant's stock and the product's total move together (the stock invariant).
          const after = await products.findOneAndUpdate(
            variantId ? { _id: productId, 'variants._id': variantId } : { _id: productId },
            {
              $inc: variantId ? { stock: change, 'variants.$.stock': change } : { stock: change },
              $set: { updatedAt: now },
            },
            { session, returnDocument: 'after' },
          );
          entries.push(
            movedEntry(after, variantId, change, {
              reason: 'counted',
              stocktakeId: _id,
              stocktakeNumber: counter.seq,
              by: byOf(req.user),
              at: now,
            }),
          );
        }
        doc = {
          _id,
          number: counter.seq,
          categoryId: category?._id ?? null,
          categoryName: category?.name ?? null,
          note: body.note,
          lines: rows.map((r) => ({
            productId: new ObjectId(r.productId),
            variantId: r.variantId ? new ObjectId(r.variantId) : null,
            title: r.label ? `${r.title} (${r.label})` : r.title,
            reserved: r.reserved,
            onShelf: r.onShelf,
            counted: r.counted,
            stockBefore: r.stock,
            stockAfter: r.stockAfter,
            short: r.short,
          })),
          by: byOf(req.user),
          createdAt: now,
        };
        await stocktakes.insertOne(doc, { session });
        await recordStock(db, entries, session);
      });
    } finally {
      await session.endSession();
    }
    await logActivity(db, req.user, {
      area: 'products',
      action: 'Counted stock',
      target: {
        label: `Stocktake #${doc.number}${doc.categoryName ? ` (${doc.categoryName})` : ''}`,
        path: `/admin/stocktakes/${doc._id}`,
      },
      changes: doc.lines
        .filter((l) => l.stockAfter !== l.stockBefore)
        .map((l) => ({ field: l.title, from: String(l.stockBefore), to: String(l.stockAfter) })),
    });
    res.status(201).json(toStocktake(doc));
  });

  return router;
}
