import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { HttpError, parse, parseObjectId } from './http.js';
import { logActivity, rupees } from './activity.js';
import { byOf } from './stockHistory.js';
import { runningOut } from './reorder.js';

// Supplier orders (stage 93): what the store asked a supplier for, printed (or saved as a PDF) and sent by the admin,
// then received against under Receiving (stockReceipts.js), which counts each delivered line towards it in the same
// transaction. Collection `purchaseOrders`:
// { number (counter 'purchaseOrderNumber', from 1, no gaps), supplier, note, expectedOn ('YYYY-MM-DD' | null),
//   lines: [{ productId, variantId | null, title (with the option), qty, unitCost | null, received }],
//   status: 'open' | 'received' (every line in full) | 'closed' (by an admin, short) | 'cancelled' (nothing came),
//   by: { id, name }, createdAt, updatedAt, closedAt? }
// Open orders' outstanding units are "on order" for the reorder suggestions (reorder.js), so nothing is ordered twice.
export const MAX_LINES = 100;
export const STATUSES = ['open', 'received', 'closed', 'cancelled'];
const PAGE = 25;

const lineBody = z.object({
  productId: z.string().regex(/^[0-9a-f]{24}$/, 'Choose a product'),
  variantId: z
    .string()
    .regex(/^[0-9a-f]{24}$/)
    .optional(),
  qty: z.number('Enter how many').int().min(1, 'At least 1').max(10_000, 'At most 10,000'),
  unitCost: z.number().int().min(0).max(100_000_000).nullable().default(null),
});
const orderBody = z.object({
  supplier: z.string().trim().min(1, 'Name the supplier').max(80),
  note: z.string().trim().max(500).default(''),
  expectedOn: z
    .union([z.literal(''), z.null(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the expected day')])
    .transform((d) => d || null)
    .default(null),
  lines: z
    .array(lineBody)
    .min(1, 'Add at least one product')
    .max(MAX_LINES, `At most ${MAX_LINES} lines`)
    .refine(
      (lines) => new Set(lines.map((l) => `${l.productId}.${l.variantId ?? ''}`)).size === lines.length,
      'Each product (and option) once',
    ),
});
const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

export const lineKey = (productId, variantId) => `${productId}.${variantId ?? ''}`;

export const toPurchaseOrder = (doc) => ({
  id: doc._id.toString(),
  number: doc.number,
  supplier: doc.supplier,
  note: doc.note,
  expectedOn: doc.expectedOn,
  status: doc.status,
  lines: doc.lines.map((l) => ({
    ...l,
    productId: l.productId.toString(),
    variantId: l.variantId?.toString() ?? null,
    outstanding: Math.max(0, l.qty - l.received),
  })),
  units: doc.lines.reduce((n, l) => n + l.qty, 0),
  received: doc.lines.reduce((n, l) => n + Math.min(l.received, l.qty), 0),
  value: doc.lines.every((l) => l.unitCost !== null) ? doc.lines.reduce((s, l) => s + l.qty * l.unitCost, 0) : null,
  by: doc.by.name,
  createdAt: doc.createdAt,
  closedAt: doc.closedAt ?? null,
});

// Counts a delivery's lines towards an open order, inside the delivery's transaction; the order becomes 'received'
// once every line has come in full. Lines the order doesn't have are left out. Throws 409 for an order not open.
export async function receiveAgainst(db, purchaseOrderId, lines, session) {
  const orders = db.collection('purchaseOrders');
  const po = await orders.findOne({ _id: purchaseOrderId }, { session });
  if (!po) throw new HttpError(400, 'purchaseOrderId: No such supplier order');
  if (po.status !== 'open') throw new HttpError(409, `Supplier order #${po.number} is ${po.status}`);
  const qty = new Map(lines.map((l) => [lineKey(l.productId, l.variantId), l.qty]));
  const updated = po.lines.map((l) => ({
    ...l,
    received: l.received + (qty.get(lineKey(l.productId, l.variantId)) ?? 0),
  }));
  const done = updated.every((l) => l.received >= l.qty);
  const now = new Date();
  await orders.updateOne(
    { _id: po._id, status: 'open' },
    {
      $set: {
        lines: updated,
        updatedAt: now,
        ...(done && { status: 'received', closedAt: now }),
      },
    },
    { session },
  );
  return po;
}

export function purchaseOrdersRouter({ db }) {
  const orders = db.collection('purchaseOrders');
  const products = db.collection('products');
  const router = express.Router();
  router.use('/admin/purchase-orders', requireAdmin);

  router.get('/admin/purchase-orders', async (req, res) => {
    const query = parse(listQuery, req.query);
    const filter = query.status ? { status: query.status } : {};
    const [docs, total, counts] = await Promise.all([
      orders
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * PAGE)
        .limit(PAGE)
        .toArray(),
      orders.countDocuments(filter),
      orders.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    ]);
    res.json({
      items: docs.map(toPurchaseOrder),
      total,
      page: query.page,
      pageSize: PAGE,
      counts: Object.fromEntries(STATUSES.map((s) => [s, counts.find((c) => c._id === s)?.n ?? 0])),
    });
  });

  // The reorder suggestions as lines for a new order (what's already on order is taken off; reorder.js).
  router.get('/admin/purchase-orders/suggested', async (req, res) => {
    const { items } = await runningOut(db, new Date(), 100);
    const wanted = items.filter((i) => i.suggest > 0);
    const docs = new Map(
      (
        await products
          .find(
            { _id: { $in: wanted.map((i) => new ObjectId(i.productId)) } },
            { projection: { cost: 1, variants: 1 } },
          )
          .toArray()
      ).map((p) => [p._id.toString(), p]),
    );
    res.json({
      lines: wanted.map((i) => {
        const p = docs.get(i.productId);
        const own = i.variantId ? p?.variants?.find((v) => v._id.toString() === i.variantId) : p;
        return {
          productId: i.productId,
          variantId: i.variantId,
          title: i.label ? `${i.title} (${i.label})` : i.title,
          qty: i.suggest,
          unitCost: own?.cost ?? null,
          stock: i.stock,
          daysLeft: i.daysLeft,
        };
      }),
    });
  });

  router.get('/admin/purchase-orders/:id', async (req, res) => {
    const doc = await orders.findOne({ _id: parseObjectId(req.params.id, 'order id') });
    if (!doc) throw new HttpError(404, 'Supplier order not found');
    const deliveries = await db
      .collection('stockReceipts')
      .find({ purchaseOrderId: doc._id }, { projection: { number: 1, createdAt: 1, lines: 1 } })
      .sort({ createdAt: 1 })
      .toArray();
    res.json({
      ...toPurchaseOrder(doc),
      deliveries: deliveries.map((d) => ({
        id: d._id.toString(),
        number: d.number,
        createdAt: d.createdAt,
        units: d.lines.reduce((n, l) => n + l.qty, 0),
      })),
    });
  });

  router.post('/admin/purchase-orders', async (req, res) => {
    const body = parse(orderBody, req.body);
    const lines = [];
    for (const line of body.lines) {
      const productId = new ObjectId(line.productId);
      const variantId = line.variantId ? new ObjectId(line.variantId) : null;
      const product = await products.findOne({ _id: productId });
      if (!product) throw new HttpError(400, 'lines: A product no longer exists');
      const variant = variantId && product.variants?.find((v) => v._id.equals(variantId));
      if (variantId && !variant) throw new HttpError(400, `lines: ${product.title} has no such option`);
      if (!variantId && product.variants?.length) {
        throw new HttpError(400, `lines: Choose which ${product.variantName.toLowerCase()} of ${product.title}`);
      }
      lines.push({
        productId,
        variantId,
        title: variant ? `${product.title} (${variant.label})` : product.title,
        qty: line.qty,
        unitCost: line.unitCost,
        received: 0,
      });
    }
    const counter = await db
      .collection('counters')
      .findOneAndUpdate(
        { _id: 'purchaseOrderNumber' },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' },
      );
    const now = new Date();
    const doc = {
      number: counter.seq,
      supplier: body.supplier,
      note: body.note,
      expectedOn: body.expectedOn,
      lines,
      status: 'open',
      by: byOf(req.user),
      createdAt: now,
      updatedAt: now,
    };
    doc._id = (await orders.insertOne(doc)).insertedId;
    await logActivity(db, req.user, {
      area: 'products',
      action: 'Made supplier order',
      target: { label: `Supplier order #${doc.number} to ${doc.supplier}`, path: `/admin/purchase-orders/${doc._id}` },
      changes: lines.map((l) => ({
        field: l.title,
        to: `${l.qty}${l.unitCost !== null ? ` at ${rupees(l.unitCost)}` : ''}`,
      })),
    });
    res.status(201).json(toPurchaseOrder(doc));
  });

  // Closes an open order short (the rest isn't coming), or cancels one nothing has come for.
  async function finish(req, res, status) {
    const _id = parseObjectId(req.params.id, 'order id');
    const now = new Date();
    const filter =
      status === 'cancelled'
        ? { _id, status: 'open', lines: { $not: { $elemMatch: { received: { $gt: 0 } } } } }
        : { _id, status: 'open' };
    const doc = await orders.findOneAndUpdate(
      filter,
      { $set: { status, closedAt: now, updatedAt: now } },
      { returnDocument: 'after' },
    );
    if (!doc) {
      const existing = await orders.findOne({ _id });
      if (!existing) throw new HttpError(404, 'Supplier order not found');
      throw new HttpError(
        409,
        existing.status === 'open'
          ? 'Part of this order has come in: close it instead'
          : `This supplier order is already ${existing.status}`,
      );
    }
    await logActivity(db, req.user, {
      area: 'products',
      action: status === 'cancelled' ? 'Cancelled supplier order' : 'Closed supplier order',
      target: { label: `Supplier order #${doc.number} to ${doc.supplier}`, path: `/admin/purchase-orders/${doc._id}` },
    });
    res.json(toPurchaseOrder(doc));
  }
  router.post('/admin/purchase-orders/:id/close', (req, res) => finish(req, res, 'closed'));
  router.post('/admin/purchase-orders/:id/cancel', (req, res) => finish(req, res, 'cancelled'));

  return router;
}
