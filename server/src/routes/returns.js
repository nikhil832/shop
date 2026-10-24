import express from 'express';
import { z } from 'zod';
import { requireAdmin, requireUser } from '../auth.js';
import { RETURN_REASONS, sendReturnDecision, sendReturnRequestAlert } from '../emails.js';
import { HttpError, parse, parseObjectId } from '../http.js';
import { refundErrorText } from '../payments.js';
import { inTransaction } from './reviews.js';
import { logActivity, rupees } from '../activity.js';

// Returns: a customer asks to send back some items of a delivered order, within RETURN_DAYS of delivery; an admin
// approves it once the items are back (stock is put back and the money refunded: through Razorpay for online payments,
// by the admin for Cash on Delivery, who then marks it refunded) or declines it with a reason.
// Statuses: requested → declined, or approved → refunded (online: at once, via refunding; COD: when marked) or
// refund_failed (retry).
export const RETURN_DAYS = 7;
const DAY = 86_400_000;
const RETURN_STATUSES = ['requested', 'approved', 'refunding', 'refunded', 'refund_failed', 'declined'];
// Items in these returns can't be returned again.
const OPEN = ['requested', 'approved', 'refunding', 'refunded', 'refund_failed'];
const PAGE = 25;

const requestBody = z.object({
  // `index` is the line's position in the order (two sizes of one product are two lines).
  items: z
    .array(z.object({ index: z.number().int().min(0).max(50), qty: z.number().int().min(1).max(10) }))
    .min(1, 'Choose at least one item to return')
    .max(50)
    .refine((items) => new Set(items.map((i) => i.index)).size === items.length, 'Each item can be listed once'),
  reason: z.enum(Object.keys(RETURN_REASONS), 'Choose a reason'),
  note: z.string().trim().max(500).default(''),
});
const listQuery = z.object({
  status: z.enum(RETURN_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
const declineBody = z.object({ reason: z.string().trim().min(1, 'Say why it is declined').max(300) });

// The last moment a delivered order can be returned, or null.
export const returnableUntil = (order) =>
  order.status === 'delivered' && order.deliveredAt ? new Date(order.deliveredAt.getTime() + RETURN_DAYS * DAY) : null;

// What returning `items` ({ index, qty }) of `order` refunds, in paise: their prices less their share of a coupon's
// discount (not of a free-delivery coupon, which was the delivery). Delivery is not refunded. Never more than what is
// left of the order's item total after `alreadyRefunded`, so rounding can't add up past it.
export function returnRefund(order, items, alreadyRefunded = 0) {
  const value = items.reduce((sum, i) => sum + order.items[i.index].price * i.qty, 0);
  const discount = order.coupon?.type === 'free_delivery' ? 0 : (order.discount ?? 0);
  const share = order.subtotal ? Math.round((discount * value) / order.subtotal) : 0;
  const itemsPaid = order.subtotal - discount;
  return Math.max(0, Math.min(value - share, itemsPaid - alreadyRefunded));
}

const toReturn = (doc) => ({
  id: doc._id.toString(),
  orderId: doc.orderId.toString(),
  orderNumber: doc.orderNumber ?? null,
  items: doc.items.map((i) => ({ ...i, productId: i.productId.toString(), variantId: i.variantId?.toString() })),
  reason: doc.reason,
  reasonText: RETURN_REASONS[doc.reason],
  note: doc.note,
  refund: doc.refund,
  refundMethod: doc.refundMethod,
  status: doc.status,
  declineReason: doc.declineReason ?? null,
  createdAt: doc.createdAt,
  decidedAt: doc.decidedAt ?? null,
  refundedAt: doc.refundedAt ?? null,
});

// For each order line, how many can still be returned (bought, less what is in open returns).
function returnableQty(order, returns) {
  const taken = new Map();
  for (const r of returns.filter((x) => OPEN.includes(x.status))) {
    for (const i of r.items) taken.set(i.index, (taken.get(i.index) ?? 0) + i.qty);
  }
  return order.items.map((line, index) => line.qty - (taken.get(index) ?? 0));
}
const refundedSoFar = (returns) => returns.filter((r) => OPEN.includes(r.status)).reduce((s, r) => s + r.refund, 0);

export function returnsRouter(ctx) {
  const { db, client } = ctx;
  const orders = db.collection('orders');
  const returns = db.collection('returns');
  const users = db.collection('users');
  const router = express.Router();

  // The customer's own order (404 for anyone else's, like the order routes).
  async function ownOrder(req) {
    const order = await orders.findOne({ _id: parseObjectId(req.params.id, 'order id'), userId: req.user._id });
    if (!order) throw new HttpError(404, 'Order not found');
    return order;
  }

  // What can be returned from this order, until when, and its returns so far.
  router.get('/orders/:id/returns', requireUser, async (req, res) => {
    const order = await ownOrder(req);
    const list = await returns.find({ orderId: order._id }).sort({ createdAt: -1 }).toArray();
    const until = returnableUntil(order);
    const open = until && until > new Date();
    res.json({
      returnableUntil: until,
      canReturn: Boolean(open),
      items: order.items.map((line, index) => ({
        index,
        title: line.title,
        image: line.image,
        price: line.price,
        qty: line.qty,
        returnable: open ? returnableQty(order, list)[index] : 0,
      })),
      returns: list.map(toReturn),
    });
  });

  router.post('/orders/:id/returns', requireUser, async (req, res) => {
    const body = parse(requestBody, req.body);
    const orderId = parseObjectId(req.params.id, 'order id');
    // In a transaction with the earlier returns, so two requests sent at once can't return the same item twice.
    const { ret, order } = await inTransaction(client, async (session) => {
      const order = await orders.findOne({ _id: orderId, userId: req.user._id }, { session });
      if (!order) throw new HttpError(404, 'Order not found');
      const until = returnableUntil(order);
      if (!until) throw new HttpError(409, 'Only delivered orders can be returned');
      if (until <= new Date()) throw new HttpError(409, `Returns are accepted for ${RETURN_DAYS} days after delivery`);
      const earlier = await returns.find({ orderId }, { session }).toArray();
      const left = returnableQty(order, earlier);
      for (const i of body.items) {
        if (i.index >= order.items.length) throw new HttpError(400, 'items: No such item in this order');
        if (i.qty > left[i.index]) {
          throw new HttpError(
            409,
            left[i.index] === 0
              ? `${order.items[i.index].title} is already being returned`
              : `Only ${left[i.index]} of ${order.items[i.index].title} can be returned`,
          );
        }
      }
      const now = new Date();
      const ret = {
        orderId,
        orderNumber: order.number ?? null,
        userId: req.user._id,
        items: body.items.map(({ index, qty }) => {
          const line = order.items[index];
          return {
            index,
            productId: line.productId,
            ...(line.variantId && { variantId: line.variantId }),
            title: line.title,
            price: line.price,
            qty,
          };
        }),
        reason: body.reason,
        note: body.note,
        refund: returnRefund(order, body.items, refundedSoFar(earlier)),
        refundMethod: order.payment?.method === 'razorpay' ? 'razorpay' : 'manual',
        status: 'requested',
        createdAt: now,
        updatedAt: now,
      };
      const { insertedId } = await returns.insertOne(ret, { session });
      // Marks the order, so the transaction conflicts with (and retries after) another request for it.
      await orders.updateOne({ _id: orderId }, { $set: { lastReturnAt: now } }, { session });
      return { ret: { ...ret, _id: insertedId }, order };
    });
    await sendReturnRequestAlert(ctx, ret, order);
    res.status(201).json(toReturn(ret));
  });

  // ---- Admin ----

  router.use('/admin/returns', requireAdmin);

  router.get('/admin/returns', async (req, res) => {
    const query = parse(listQuery, req.query);
    const filter = query.status ? { status: query.status } : {};
    const [docs, total, counts] = await Promise.all([
      returns
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * PAGE)
        .limit(PAGE)
        .toArray(),
      returns.countDocuments(filter),
      returns.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    ]);
    const people = await users
      .find({ _id: { $in: [...new Set(docs.map((r) => r.userId))] } }, { projection: { name: 1, email: 1 } })
      .toArray();
    const byId = new Map(people.map((u) => [u._id.toString(), { name: u.name, email: u.email }]));
    res.json({
      items: docs.map((r) => ({ ...toReturn(r), customer: byId.get(r.userId.toString()) ?? null })),
      total,
      page: query.page,
      pageSize: PAGE,
      counts: Object.fromEntries(RETURN_STATUSES.map((s) => [s, counts.find((c) => c._id === s)?.n ?? 0])),
    });
  });

  // Refunds an approved online return through Razorpay (part of the payment); claims it first, so it runs once.
  async function refundOnline(ret) {
    const claimed = await returns.findOneAndUpdate(
      { _id: ret._id, refundMethod: 'razorpay', status: { $in: ['approved', 'refund_failed'] } },
      { $set: { status: 'refunding', updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!claimed) return returns.findOne({ _id: ret._id });
    const order = await orders.findOne({ _id: ret.orderId });
    let result;
    try {
      if (!ctx.razorpay) throw new Error('Online payments are not configured on this server');
      const refund = await ctx.razorpay.refund(order.payment.razorpayPaymentId, {
        amount: claimed.refund,
        notes: { order: String(order.number), return: String(claimed._id) },
      });
      result = {
        $set: { status: 'refunded', refundId: refund.id, refundedAt: new Date() },
        $unset: { refundError: '' },
      };
    } catch (err) {
      result = { $set: { status: 'refund_failed', refundError: refundErrorText(err, claimed.refund) } };
    }
    return returns.findOneAndUpdate(
      { _id: ret._id },
      { ...result, $currentDate: { updatedAt: true } },
      { returnDocument: 'after' },
    );
  }

  const adminView = (doc) => ({ ...toReturn(doc), refundError: doc.refundError ?? null });
  const logReturn = (req, ret, action, changes = []) =>
    logActivity(db, req.user, {
      area: 'returns',
      action,
      target: {
        label: `Order #${ret.orderNumber ?? ret.orderId.toString().slice(-8).toUpperCase()}`,
        path: `/admin/orders/${ret.orderId}`,
      },
      changes: [{ field: 'Refund', to: `${rupees(ret.refund)} (${ret.status.replace('_', ' ')})` }, ...changes],
    });

  // Approve once the items are back: in one transaction the return is approved and its stock put back (to the variant
  // bought and the product's total, like a cancellation). Then the refund: online at once; COD by the admin.
  router.post('/admin/returns/:id/approve', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'return id');
    let ret = await inTransaction(client, async (session) => {
      const now = new Date();
      const doc = await returns.findOneAndUpdate(
        { _id, status: 'requested' },
        { $set: { status: 'approved', decidedAt: now, decidedBy: req.user._id, updatedAt: now } },
        { session, returnDocument: 'after' },
      );
      if (!doc) {
        const existing = await returns.findOne({ _id }, { session });
        if (!existing) throw new HttpError(404, 'Return not found');
        throw new HttpError(409, `This return is already ${existing.status}`);
      }
      await db.collection('products').bulkWrite(
        doc.items.map((i) => ({
          updateOne: i.variantId
            ? {
                filter: { _id: i.productId, 'variants._id': i.variantId },
                update: { $inc: { stock: i.qty, 'variants.$.stock': i.qty }, $set: { updatedAt: now } },
              }
            : { filter: { _id: i.productId }, update: { $inc: { stock: i.qty }, $set: { updatedAt: now } } },
        })),
        { session },
      );
      return doc;
    });
    if (ret.refundMethod === 'razorpay') ret = await refundOnline(ret);
    await logReturn(req, ret, 'Approved return');
    await sendReturnDecision(ctx, ret, await orders.findOne({ _id: ret.orderId }));
    res.json(adminView(ret));
  });

  router.post('/admin/returns/:id/decline', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'return id');
    const { reason } = parse(declineBody, req.body);
    const now = new Date();
    const ret = await returns.findOneAndUpdate(
      { _id, status: 'requested' },
      { $set: { status: 'declined', declineReason: reason, decidedAt: now, decidedBy: req.user._id, updatedAt: now } },
      { returnDocument: 'after' },
    );
    if (!ret) {
      const existing = await returns.findOne({ _id });
      if (!existing) throw new HttpError(404, 'Return not found');
      throw new HttpError(409, `This return is already ${existing.status}`);
    }
    await logReturn(req, ret, 'Declined return', [{ field: 'Reason', to: reason }]);
    await sendReturnDecision(ctx, ret, await orders.findOne({ _id: ret.orderId }));
    res.json(adminView(ret));
  });

  // A Cash on Delivery refund the admin paid themselves (UPI, bank transfer): recorded as done.
  router.post('/admin/returns/:id/refunded', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'return id');
    const ret = await returns.findOneAndUpdate(
      { _id, status: 'approved', refundMethod: 'manual' },
      { $set: { status: 'refunded', refundedAt: new Date(), updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!ret) throw new HttpError(409, 'Only an approved Cash on Delivery return can be marked refunded');
    await logReturn(req, ret, 'Marked return refunded');
    res.json(adminView(ret));
  });

  // Tries an online refund again after Razorpay refused it.
  router.post('/admin/returns/:id/refund', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'return id');
    const ret = await returns.findOne({ _id });
    if (!ret) throw new HttpError(404, 'Return not found');
    if (ret.status !== 'refund_failed') throw new HttpError(409, 'Only a return whose refund failed can be retried');
    const after = await refundOnline(ret);
    await logReturn(req, after, 'Retried return refund');
    res.json(adminView(after));
  });

  // The returns of one order, for the admin's order page.
  router.get('/admin/orders/:id/returns', requireAdmin, async (req, res) => {
    const orderId = parseObjectId(req.params.id, 'order id');
    res.json((await returns.find({ orderId }).sort({ createdAt: -1 }).toArray()).map(adminView));
  });

  return router;
}
