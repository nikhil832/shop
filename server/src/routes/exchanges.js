import express from 'express';
import { z } from 'zod';
import { requireAdmin, requireUser } from '../auth.js';
import { EXCHANGE_REASONS, sendExchangeRequestAlert, sendExchangeUpdate } from '../emails.js';
import { HttpError, parse, parseObjectId } from '../http.js';
import { logActivity } from '../activity.js';
import { byOf, movedEntry, recordStock } from '../stockHistory.js';
import { inTransaction } from './reviews.js';
import { RETURN_DAYS, returnableQty, returnableUntil } from './returns.js';
import { shipmentFields, toShipment } from './admin.js';

// Exchanges (stage 89, collection `exchanges`): within the return window, a customer swaps items of a delivered order
// for another option (size, colour) of the same product at the same price, so no money moves and the order, its
// invoice and the sales figures stay as they are. The new option is set aside (stock taken) when asked, so it can't
// sell out meanwhile. Statuses: requested → approved (the items are back: their stock returns) → shipped → delivered;
// or requested → declined (by an admin) / cancelled (by the customer), which gives the set-aside stock back.
// { orderId, orderNumber, userId, items: [{ index, productId, title, fromVariantId, fromLabel, toVariantId, toLabel,
//   qty }], reason, note, status, declineReason?, shipment?, createdAt, updatedAt, decidedAt?, decidedBy?, shippedAt?,
//   deliveredAt?, cancelledAt? }
const STATUSES = ['requested', 'approved', 'shipped', 'delivered', 'declined', 'cancelled'];
const PAGE = 25;

const requestBody = z.object({
  items: z
    .array(
      z.object({
        index: z.number().int().min(0).max(50),
        qty: z.number().int().min(1).max(10),
        variantId: z.string().regex(/^[0-9a-f]{24}$/, 'Choose the option you want instead'),
      }),
    )
    .min(1, 'Choose at least one item to exchange')
    .max(50)
    .refine((items) => new Set(items.map((i) => i.index)).size === items.length, 'Each item can be listed once'),
  reason: z.enum(Object.keys(EXCHANGE_REASONS), 'Choose a reason'),
  note: z.string().trim().max(500).default(''),
});
const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
const declineBody = z.object({ reason: z.string().trim().min(1, 'Say why it is declined').max(300) });
const shipBody = z.object({ shipment: shipmentFields.optional() });

// The options an order line can be exchanged for: the product's other options (still on sale) that cost what the
// bought one costs today (or what was paid, if that option is gone), each with whether there's one in stock. Only
// for lines bought with an option.
export function exchangeOptions(line, product) {
  if (!line.variantId || !product?.active || !product.variants?.length) return [];
  const bought = product.variants.find((v) => v._id.equals(line.variantId));
  const price = bought ? bought.price : line.price;
  return product.variants
    .filter((v) => !v._id.equals(line.variantId) && v.price === price)
    .map((v) => ({ id: v._id.toString(), label: v.label, stock: v.stock }));
}

export const toExchange = (doc) => ({
  id: doc._id.toString(),
  orderId: doc.orderId.toString(),
  orderNumber: doc.orderNumber ?? null,
  items: doc.items.map((i) => ({
    index: i.index,
    productId: i.productId.toString(),
    title: i.title,
    fromLabel: i.fromLabel,
    toLabel: i.toLabel,
    toVariantId: i.toVariantId.toString(),
    qty: i.qty,
  })),
  reason: doc.reason,
  reasonText: EXCHANGE_REASONS[doc.reason],
  note: doc.note,
  status: doc.status,
  declineReason: doc.declineReason ?? null,
  shipment: doc.shipment ?? null,
  createdAt: doc.createdAt,
  decidedAt: doc.decidedAt ?? null,
  shippedAt: doc.shippedAt ?? null,
  deliveredAt: doc.deliveredAt ?? null,
});

export function exchangesRouter(ctx) {
  const { db, client } = ctx;
  const orders = db.collection('orders');
  const exchanges = db.collection('exchanges');
  const products = db.collection('products');
  const router = express.Router();

  // Moves each item's stock by `sign` × qty: to the new option (`to`) or the one sent back (`from`), recording the
  // change. A product or option deleted since gets nothing, like cancellations.
  async function moveStock(ex, which, sign, reason, user, session) {
    const now = new Date();
    const entries = [];
    for (const i of ex.items) {
      const variantId = which === 'to' ? i.toVariantId : i.fromVariantId;
      const after = await products.findOneAndUpdate(
        { _id: i.productId, 'variants._id': variantId },
        { $inc: { stock: sign * i.qty, 'variants.$.stock': sign * i.qty }, $set: { updatedAt: now } },
        { session, returnDocument: 'after' },
      );
      if (after) {
        entries.push(
          movedEntry(after, variantId, sign * i.qty, {
            reason,
            orderId: ex.orderId,
            orderNumber: ex.orderNumber,
            exchangeId: ex._id,
            by: byOf(user),
            at: now,
          }),
        );
      }
    }
    await recordStock(db, entries, session);
  }

  // Moves an exchange on from `from` (statuses) with `set`, in the caller's transaction; 404/409 otherwise.
  async function step(_id, from, set, session) {
    const doc = await exchanges.findOneAndUpdate(
      { _id, status: { $in: from } },
      { $set: { ...set, updatedAt: new Date() } },
      { session, returnDocument: 'after' },
    );
    if (doc) return doc;
    const existing = await exchanges.findOne({ _id }, { session });
    if (!existing) throw new HttpError(404, 'Exchange not found');
    throw new HttpError(409, `This exchange is already ${existing.status}`);
  }

  // What each line of the customer's own delivered order can be exchanged for, until when, and its exchanges so far.
  router.get('/orders/:id/exchanges', requireUser, async (req, res) => {
    const order = await orders.findOne({ _id: parseObjectId(req.params.id, 'order id'), userId: req.user._id });
    if (!order) throw new HttpError(404, 'Order not found');
    const [list, returns, docs] = await Promise.all([
      exchanges.find({ orderId: order._id }).sort({ createdAt: -1 }).toArray(),
      db.collection('returns').find({ orderId: order._id }).toArray(),
      products.find({ _id: { $in: order.items.map((i) => i.productId) } }).toArray(),
    ]);
    const byId = new Map(docs.map((p) => [p._id.toString(), p]));
    const until = returnableUntil(order);
    const open = Boolean(until && until > new Date());
    const left = returnableQty(order, returns, list);
    res.json({
      exchangeableUntil: until,
      canExchange: open,
      items: order.items.map((line, index) => ({
        index,
        title: line.title,
        image: line.image,
        price: line.price,
        qty: line.qty,
        variant: line.variant ?? null,
        exchangeable: open ? left[index] : 0,
        options: open ? exchangeOptions(line, byId.get(line.productId.toString())) : [],
      })),
      exchanges: list.map(toExchange),
    });
  });

  router.post('/orders/:id/exchanges', requireUser, async (req, res) => {
    const body = parse(requestBody, req.body);
    const orderId = parseObjectId(req.params.id, 'order id');
    // With the order's returns and exchanges in one transaction (see returns.js), so an item can't be returned and
    // exchanged at once; the new options' stock is taken in it too.
    const { ex, order } = await inTransaction(client, async (session) => {
      const order = await orders.findOne({ _id: orderId, userId: req.user._id }, { session });
      if (!order) throw new HttpError(404, 'Order not found');
      const until = returnableUntil(order);
      if (!until) throw new HttpError(409, 'Only delivered orders can be exchanged');
      if (until <= new Date())
        throw new HttpError(409, `Exchanges are accepted for ${RETURN_DAYS} days after delivery`);
      const [returns, earlier] = await Promise.all([
        db.collection('returns').find({ orderId }, { session }).toArray(),
        exchanges.find({ orderId }, { session }).toArray(),
      ]);
      const left = returnableQty(order, returns, earlier);
      const now = new Date();
      const items = [];
      for (const i of body.items) {
        const line = order.items[i.index];
        if (!line) throw new HttpError(400, 'items: No such item in this order');
        if (i.qty > left[i.index]) {
          throw new HttpError(
            409,
            left[i.index] === 0
              ? `${line.title} is already being returned or exchanged`
              : `Only ${left[i.index]} of ${line.title} can be exchanged`,
          );
        }
        const product = await products.findOne({ _id: line.productId }, { session });
        const option = exchangeOptions(line, product).find((o) => o.id === i.variantId);
        if (!option) throw new HttpError(409, `${line.title} can't be exchanged for that option`);
        if (option.stock < i.qty) {
          throw new HttpError(
            409,
            option.stock === 0 ? `${option.label} is sold out` : `Only ${option.stock} of ${option.label} are left`,
          );
        }
        const from = product.variants.find((v) => v._id.equals(line.variantId));
        items.push({
          index: i.index,
          productId: line.productId,
          title: product.title,
          fromVariantId: line.variantId,
          fromLabel: from?.label ?? line.variant,
          toVariantId: parseObjectId(option.id, 'option'),
          toLabel: option.label,
          qty: i.qty,
        });
      }
      const ex = {
        orderId,
        orderNumber: order.number ?? null,
        userId: req.user._id,
        items,
        reason: body.reason,
        note: body.note,
        status: 'requested',
        createdAt: now,
        updatedAt: now,
      };
      ex._id = (await exchanges.insertOne(ex, { session })).insertedId;
      // Sets the new options aside; the check is in the filter, so two items wanting the last one can't both have it.
      for (const i of items) {
        const after = await products.findOneAndUpdate(
          { _id: i.productId, variants: { $elemMatch: { _id: i.toVariantId, stock: { $gte: i.qty } } } },
          { $inc: { stock: -i.qty, 'variants.$.stock': -i.qty }, $set: { updatedAt: now } },
          { session, returnDocument: 'after' },
        );
        if (!after) throw new HttpError(409, `Not enough of ${i.toLabel} left`);
        await recordStock(
          db,
          [
            movedEntry(after, i.toVariantId, -i.qty, {
              reason: 'exchange_reserved',
              orderId,
              orderNumber: ex.orderNumber,
              exchangeId: ex._id,
              by: null,
              at: now,
            }),
          ],
          session,
        );
      }
      // Marks the order, so the transaction conflicts with (and retries after) another return or exchange for it.
      await orders.updateOne({ _id: orderId }, { $set: { lastReturnAt: now } }, { session });
      return { ex, order };
    });
    await sendExchangeRequestAlert(ctx, ex, order);
    res.status(201).json(toExchange(ex));
  });

  // The customer calls it off while it's waiting: the set-aside options go back on sale.
  router.post('/orders/:id/exchanges/:exchangeId/cancel', requireUser, async (req, res) => {
    const orderId = parseObjectId(req.params.id, 'order id');
    const _id = parseObjectId(req.params.exchangeId, 'exchange id');
    if (!(await exchanges.findOne({ _id, orderId, userId: req.user._id }))) {
      throw new HttpError(404, 'Exchange not found');
    }
    const ex = await inTransaction(client, async (session) => {
      const doc = await step(_id, ['requested'], { status: 'cancelled', cancelledAt: new Date() }, session);
      await moveStock(doc, 'to', 1, 'exchange_released', null, session);
      return doc;
    });
    res.json(toExchange(ex));
  });

  // ---- Admin ----

  router.use('/admin/exchanges', requireAdmin);

  router.get('/admin/exchanges', async (req, res) => {
    const query = parse(listQuery, req.query);
    const filter = query.status ? { status: query.status } : {};
    const [docs, total, counts] = await Promise.all([
      exchanges
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * PAGE)
        .limit(PAGE)
        .toArray(),
      exchanges.countDocuments(filter),
      exchanges.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    ]);
    const people = await db
      .collection('users')
      .find({ _id: { $in: [...new Set(docs.map((x) => x.userId))] } }, { projection: { name: 1, email: 1 } })
      .toArray();
    const byId = new Map(people.map((u) => [u._id.toString(), { name: u.name, email: u.email }]));
    res.json({
      items: docs.map((x) => ({ ...toExchange(x), customer: byId.get(x.userId.toString()) ?? null })),
      total,
      page: query.page,
      pageSize: PAGE,
      counts: Object.fromEntries(STATUSES.map((s) => [s, counts.find((c) => c._id === s)?.n ?? 0])),
    });
  });

  const logExchange = (req, ex, action, changes = []) =>
    logActivity(db, req.user, {
      area: 'returns',
      action,
      target: {
        label: `Order #${ex.orderNumber ?? ex.orderId.toString().slice(-8).toUpperCase()}`,
        path: `/admin/orders/${ex.orderId}`,
      },
      changes: [
        {
          field: 'Exchange',
          to: ex.items.map((i) => `${i.title}: ${i.fromLabel} → ${i.toLabel} × ${i.qty}`).join(', '),
        },
        ...changes,
      ],
    });
  // Logs and emails the customer once the change is saved.
  async function done(req, res, ex, action, changes) {
    await logExchange(req, ex, action, changes);
    await sendExchangeUpdate(ctx, ex, await orders.findOne({ _id: ex.orderId }));
    res.json(toExchange(ex));
  }

  // Once the items are back: their stock returns (to the option bought).
  router.post('/admin/exchanges/:id/approve', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'exchange id');
    const ex = await inTransaction(client, async (session) => {
      const now = new Date();
      const doc = await step(
        _id,
        ['requested'],
        { status: 'approved', decidedAt: now, decidedBy: req.user._id },
        session,
      );
      await moveStock(doc, 'from', 1, 'exchange_returned', req.user, session);
      return doc;
    });
    await done(req, res, ex, 'Approved exchange');
  });

  router.post('/admin/exchanges/:id/decline', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'exchange id');
    const { reason } = parse(declineBody, req.body);
    const ex = await inTransaction(client, async (session) => {
      const now = new Date();
      const doc = await step(
        _id,
        ['requested'],
        { status: 'declined', declineReason: reason, decidedAt: now, decidedBy: req.user._id },
        session,
      );
      await moveStock(doc, 'to', 1, 'exchange_released', req.user, session);
      return doc;
    });
    await done(req, res, ex, 'Declined exchange', [{ field: 'Reason', to: reason }]);
  });

  // The new items are sent, with the courier and tracking number if given (like shipping an order).
  router.post('/admin/exchanges/:id/ship', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'exchange id');
    const shipment = toShipment(parse(shipBody, req.body).shipment);
    const ex = await step(_id, ['approved'], {
      status: 'shipped',
      shippedAt: new Date(),
      ...(shipment && { shipment }),
    });
    await done(
      req,
      res,
      ex,
      'Shipped exchange',
      shipment?.trackingNumber ? [{ field: 'Tracking', to: `${shipment.courier} ${shipment.trackingNumber}` }] : [],
    );
  });

  router.post('/admin/exchanges/:id/delivered', async (req, res) => {
    const ex = await step(parseObjectId(req.params.id, 'exchange id'), ['shipped'], {
      status: 'delivered',
      deliveredAt: new Date(),
    });
    await logExchange(req, ex, 'Delivered exchange');
    res.json(toExchange(ex));
  });

  // The exchanges of one order, for the admin's order page.
  router.get('/admin/orders/:id/exchanges', requireAdmin, async (req, res) => {
    const orderId = parseObjectId(req.params.id, 'order id');
    res.json((await exchanges.find({ orderId }).sort({ createdAt: -1 }).toArray()).map(toExchange));
  });

  return router;
}
