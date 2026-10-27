import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { logActivity } from './activity.js';
import { requireAdmin } from './auth.js';
import { HttpError, parse, parseObjectId } from './http.js';

// Scheduled sales (stage 67): a percentage off a category's products or chosen products, from `startsAt` to `endsAt`.
// Collection `sales` { name, percent, categoryId | null, productIds, startsAt, endsAt, createdBy, createdAt,
// startedAt, endedAt, cancelledAt, applied, skipped }. runSales() (the minute sweep, and straight after an admin's
// change) really changes the prices when a sale starts and puts them back when it ends, so listings, filters, sorting,
// the cart, orders, invoices and price-drop emails all just see prices. A product on sale has
// `sale` { id, name, percent, endsAt, regularPrice, regularVariants: [{ id, price }] }; while it does, its prices can't
// be edited (assertPriceUnchanged). A product is in one running sale at a time (later sales skip it). Only prices
// change, one variant at a time with positional updates, so stock is never written over. MRP stays, so the discount
// shows against it.

export const MAX_DAYS = 31;
const MIN_PRICE = 100; // ₹1

// The sale price: `percent` off, rounded down to whole rupees, never under ₹1.
export const salePrice = (price, percent) =>
  Math.max(MIN_PRICE, Math.floor((price * (100 - percent)) / 100 / 100) * 100);

// Refuses a product edit that changes a price (or MRP) while the product is on sale; other fields are fine.
export function assertPriceUnchanged(current, next) {
  if (!current.sale) return;
  const changed =
    (next.price !== undefined && next.price !== current.price) ||
    (next.mrp !== undefined && next.mrp !== current.mrp) ||
    (next.variants ?? []).some((v) => {
      const old = current.variants?.find((x) => x._id.equals(v._id));
      return old && (old.price !== v.price || old.mrp !== v.mrp);
    });
  if (changed) {
    throw new HttpError(
      409,
      `This product is in the "${current.sale.name}" sale until ${current.sale.endsAt.toISOString().slice(0, 10)}. ` +
        'Change its prices after the sale, or end the sale first.',
    );
  }
}

// Positional updates for variant prices: { $set fields, arrayFilters } for [{ id, price }].
function variantPrices(list) {
  const set = {};
  const arrayFilters = [];
  list.forEach(({ id, price }, i) => {
    set[`variants.$[v${i}].price`] = price;
    arrayFilters.push({ [`v${i}._id`]: id });
  });
  return { set, arrayFilters };
}

async function startSale(db, sale, now) {
  const products = db.collection('products');
  const scope = sale.categoryId ? { categoryId: sale.categoryId } : { _id: { $in: sale.productIds } };
  let applied = 0;
  for (const p of await products.find({ ...scope, sale: { $exists: false } }).toArray()) {
    const regularVariants = (p.variants ?? []).map((v) => ({ id: v._id, price: v.price }));
    const discounted = regularVariants.map((v) => ({ id: v.id, price: salePrice(v.price, sale.percent) }));
    const { set, arrayFilters } = variantPrices(discounted);
    const { modifiedCount } = await products.updateOne(
      { _id: p._id, sale: { $exists: false }, price: p.price },
      {
        $set: {
          ...set,
          // With variants, the product's price is its cheapest variant's (the same one, as all lose the same share).
          price: discounted.length ? Math.min(...discounted.map((v) => v.price)) : salePrice(p.price, sale.percent),
          sale: {
            id: sale._id,
            name: sale.name,
            percent: sale.percent,
            endsAt: sale.endsAt,
            regularPrice: p.price,
            regularVariants,
          },
          updatedAt: now,
        },
      },
      arrayFilters.length ? { arrayFilters } : {},
    );
    applied += modifiedCount;
  }
  const inScope = await products.countDocuments(scope);
  await db.collection('sales').updateOne({ _id: sale._id }, { $set: { applied, skipped: inScope - applied } });
}

async function endSale(db, sale, now) {
  const products = db.collection('products');
  for (const p of await products.find({ 'sale.id': sale._id }).toArray()) {
    // Variants still there get their regular price back; ones added during the sale keep theirs.
    const back = p.sale.regularVariants.filter((r) => p.variants?.some((v) => v._id.equals(r.id)));
    const { set, arrayFilters } = variantPrices(back);
    const prices = (p.variants ?? []).map((v) => back.find((r) => r.id.equals(v._id))?.price ?? v.price);
    await products.updateOne(
      { _id: p._id, 'sale.id': sale._id },
      {
        $set: { ...set, price: prices.length ? Math.min(...prices) : p.sale.regularPrice, updatedAt: now },
        $unset: { sale: '' },
      },
      arrayFilters.length ? { arrayFilters } : {},
    );
  }
}

// Starts the sales due and ends the ones over (or ended early). Each is claimed first, so it's done once.
export async function runSales(ctx, now = new Date()) {
  const sales = ctx.db.collection('sales');
  for (;;) {
    const sale = await sales.findOneAndUpdate(
      { startedAt: null, cancelledAt: null, startsAt: { $lte: now }, endsAt: { $gt: now } },
      { $set: { startedAt: now } },
      { sort: { startsAt: 1 }, returnDocument: 'after' },
    );
    if (!sale) break;
    await startSale(ctx.db, sale, now);
  }
  for (;;) {
    const sale = await sales.findOneAndUpdate(
      {
        startedAt: { $ne: null },
        endedAt: null,
        $or: [{ endsAt: { $lte: now } }, { cancelledAt: { $ne: null } }],
      },
      { $set: { endedAt: now } },
      { returnDocument: 'after' },
    );
    if (!sale) break;
    await endSale(ctx.db, sale, now);
  }
}

const date = z.coerce.date('Enter a date and time');
const saleBody = z
  .object({
    name: z.string().trim().min(1, 'Name the sale').max(40, 'At most 40 characters'),
    percent: z.number().int().min(1, 'From 1% off').max(90, 'At most 90% off'),
    startsAt: date,
    endsAt: date,
    categoryId: z
      .string()
      .regex(/^[0-9a-f]{24}$/, 'Choose a category')
      .optional(),
    productIds: z
      .array(z.string().regex(/^[0-9a-f]{24}$/))
      .max(200, 'At most 200 products')
      .optional(),
  })
  .refine((b) => Boolean(b.categoryId) !== Boolean(b.productIds?.length), 'Choose a category or some products')
  .refine((b) => b.endsAt > b.startsAt, { message: 'The end must be after the start', path: ['endsAt'] })
  .refine((b) => b.endsAt - b.startsAt <= MAX_DAYS * 86_400_000, {
    message: `A sale can run for at most ${MAX_DAYS} days`,
    path: ['endsAt'],
  });

const statusOf = (s) =>
  s.cancelledAt && !s.startedAt ? 'cancelled' : s.endedAt ? 'ended' : s.startedAt ? 'running' : 'upcoming';

export function salesRouter(ctx) {
  const { db } = ctx;
  const sales = db.collection('sales');
  const router = express.Router();
  router.use('/admin/sales', requireAdmin);

  // Newest first, with what each covers.
  router.get('/admin/sales', async (req, res) => {
    const docs = await sales.find().sort({ startsAt: -1 }).limit(100).toArray();
    const categories = new Map(
      (
        await db
          .collection('categories')
          .find({}, { projection: { name: 1 } })
          .toArray()
      ).map((c) => [c._id.toString(), c.name]),
    );
    res.json({
      items: docs.map((s) => ({
        id: s._id.toString(),
        name: s.name,
        percent: s.percent,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        status: statusOf(s),
        covers: s.categoryId
          ? `All of ${categories.get(s.categoryId.toString()) ?? 'a deleted category'}`
          : `${s.productIds.length} chosen ${s.productIds.length === 1 ? 'product' : 'products'}`,
        applied: s.applied ?? null,
        skipped: s.skipped ?? null,
      })),
    });
  });

  router.post('/admin/sales', async (req, res) => {
    const body = parse(saleBody, req.body);
    const now = new Date();
    if (body.endsAt <= now) throw new HttpError(400, 'endsAt: The sale would be over already');
    let label;
    if (body.categoryId) {
      const category = await db.collection('categories').findOne({ _id: new ObjectId(body.categoryId) });
      if (!category) throw new HttpError(400, 'categoryId: Choose a category');
      label = `All of ${category.name}`;
    } else {
      const ids = [...new Set(body.productIds)].map((id) => new ObjectId(id));
      if ((await db.collection('products').countDocuments({ _id: { $in: ids } })) !== ids.length) {
        throw new HttpError(400, 'productIds: A chosen product no longer exists');
      }
      body.productIds = ids;
      label = `${ids.length} chosen ${ids.length === 1 ? 'product' : 'products'}`;
    }
    const doc = {
      name: body.name,
      percent: body.percent,
      categoryId: body.categoryId ? new ObjectId(body.categoryId) : null,
      productIds: body.productIds ?? [],
      startsAt: body.startsAt < now ? now : body.startsAt,
      endsAt: body.endsAt,
      createdBy: req.user._id,
      createdAt: now,
      startedAt: null,
      endedAt: null,
      cancelledAt: null,
    };
    const { insertedId } = await sales.insertOne(doc);
    await logActivity(db, req.user, {
      area: 'sales',
      action: 'Scheduled sale',
      target: { label: doc.name, path: '/admin/sales' },
      changes: [
        { field: 'Discount', to: `${doc.percent}% off` },
        { field: 'Covers', to: label },
        { field: 'From', to: doc.startsAt.toISOString() },
        { field: 'Until', to: doc.endsAt.toISOString() },
      ],
    });
    await runSales(ctx); // one starting now starts now
    res.status(201).json({ id: insertedId.toString(), status: statusOf(await sales.findOne({ _id: insertedId })) });
  });

  // Ends a running sale now (prices go back), or calls off one that hasn't started.
  router.post('/admin/sales/:id/end', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'sale id');
    const sale = await sales.findOneAndUpdate(
      { _id, cancelledAt: null, endedAt: null },
      { $set: { cancelledAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!sale) {
      if (!(await sales.findOne({ _id }, { projection: { _id: 1 } }))) throw new HttpError(404, 'Sale not found');
      throw new HttpError(409, 'This sale is already over');
    }
    await runSales(ctx);
    await logActivity(db, req.user, {
      area: 'sales',
      action: sale.startedAt ? 'Ended sale early' : 'Called off sale',
      target: { label: sale.name, path: '/admin/sales' },
    });
    res.json({ status: statusOf(await sales.findOne({ _id })) });
  });

  return router;
}
