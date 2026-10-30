import express from 'express';
import { z } from 'zod';
import { ObjectId } from 'mongodb';
import { requireAdmin, requireUser } from '../auth.js';
import { logActivity, rupees } from '../activity.js';
import { addCredit } from '../credit.js';
import { sendItemsCancelled } from '../emails.js';
import { HttpError, parse, parseObjectId } from '../http.js';
import { refundErrorText } from '../payments.js';
import { byOf, CANCEL_REASONS, movedEntry, recordStock } from '../stockHistory.js';
import { toOrder } from './orders.js';
import { inTransaction } from './reviews.js';

// Cancelling some items of an order before it ships (stage 97), by its customer or an admin, while it is `placed`.
// The order itself changes, since nothing has been invoiced to a courier yet: cancelled units leave `items` (a line
// down to 0 is removed; returns and exchanges, which address lines by index, only exist once delivered), `subtotal`,
// `discount` and `total` are worked out again, and the cancellation is kept in `cancellations`. So the tax invoice,
// packing slip, Cash on Delivery amount, dashboard, profit and cashback all follow without anything else. The
// delivery charge stays as it was (no new charge when the rest falls under the free-delivery amount), and a coupon
// stays applied: its discount shrinks by the cancelled items' share in whole rupees (a free-delivery coupon's stays).
// What the order no longer costs comes back money first for a paid online order (a part refund through Razorpay,
// after the transaction, retried by an admin if it fails), then store credit; a Cash on Delivery order just collects
// less, and gives back credit beyond its new total. At least one unit must stay: cancelling everything is the whole
// order's cancel.
export const MAX_CANCELLATIONS = 10;

const cancelBody = z.object({
  // `index` is the line's position in the order (two sizes of one product are two lines).
  items: z
    .array(z.object({ index: z.number().int().min(0).max(50), qty: z.number().int().min(1).max(10) }))
    .min(1, 'Choose at least one item to cancel')
    .max(50)
    .refine((items) => new Set(items.map((i) => i.index)).size === items.length, 'Each item can be listed once'),
  // Only work out what would change, saving nothing (for the confirmation).
  preview: z.boolean().default(false),
});

const orderLabel = (order) => `Order #${order.number ?? order._id.toString().slice(-8).toUpperCase()}`;

// What cancelling `cancel` ([{ index, qty }]) of `order` changes, in paise. Throws a 400/409 for items that aren't
// there or would leave nothing.
export function cancellationPlan(order, cancel) {
  const items = order.items.map((line) => ({ ...line }));
  for (const c of cancel) {
    const line = items[c.index];
    if (!line) throw new HttpError(400, 'items: No such item in this order');
    if (c.qty > line.qty) throw new HttpError(409, `Only ${line.qty} of ${line.title} is in this order`);
    line.qty -= c.qty;
  }
  if (items.every((line) => line.qty === 0)) {
    throw new HttpError(409, 'To cancel everything, cancel the whole order instead');
  }
  const value = cancel.reduce((sum, c) => sum + order.items[c.index].price * c.qty, 0);
  const subtotal = order.subtotal - value;
  const discount = order.discount ?? 0;
  const share =
    order.coupon?.type === 'free_delivery' || !order.subtotal
      ? 0
      : Math.round((discount * value) / order.subtotal / 100) * 100;
  const newDiscount = Math.max(0, Math.min(discount - share, subtotal));
  const total = subtotal + order.delivery - newDiscount;
  const creditUsed = order.creditUsed ?? 0;
  // Money already taken for a paid online order; a COD order's money comes on delivery.
  const moneyPaid =
    order.payment?.method === 'razorpay' && order.payment.status === 'paid' ? order.total - creditUsed : 0;
  const money = Math.min(moneyPaid, total);
  const newCreditUsed = moneyPaid ? total - money : Math.min(creditUsed, total);
  const bundleSaving = items.reduce((sum, i) => sum + (i.bundle ? (i.regularPrice - i.price) * i.qty : 0), 0);
  return {
    items: items.filter((line) => line.qty > 0),
    cancelled: cancel.map((c) => {
      const line = order.items[c.index];
      return {
        productId: line.productId,
        ...(line.variantId && { variantId: line.variantId }),
        title: line.title,
        image: line.image,
        price: line.price,
        qty: c.qty,
      };
    }),
    subtotal,
    discount: newDiscount,
    total,
    creditUsed: newCreditUsed,
    bundleSaving,
    // What the order no longer costs, and how it comes back.
    amount: order.total - total,
    refund: moneyPaid - money,
    creditBack: creditUsed - newCreditUsed,
  };
}

// What a preview shows: the new total and how the difference comes back.
const toPlan = (order, plan) => ({
  total: plan.total,
  amount: plan.amount,
  refund: plan.refund,
  creditBack: plan.creditBack,
  // Still to pay on delivery for a Cash on Delivery order.
  toCollect: order.payment?.method === 'cod' ? plan.total - plan.creditUsed : null,
});

// Sends a cancellation's part refund through Razorpay. The entry is claimed first (pending or failed → refunding), so
// only one caller refunds; a failure is kept for an admin's retry. Returns the order after.
export async function refundCancellation({ db, razorpay }, orderId, cancellationId) {
  const orders = db.collection('orders');
  const claimed = await orders.findOneAndUpdate(
    {
      _id: orderId,
      cancellations: { $elemMatch: { _id: cancellationId, refundStatus: { $in: ['pending', 'refund_failed'] } } },
    },
    { $set: { 'cancellations.$.refundStatus': 'refunding' } },
    { returnDocument: 'after' },
  );
  if (!claimed) return orders.findOne({ _id: orderId });
  const entry = claimed.cancellations.find((c) => c._id.equals(cancellationId));
  let result;
  try {
    if (!razorpay) throw new Error('Online payments are not configured on this server');
    const refund = await razorpay.refund(claimed.payment.razorpayPaymentId, {
      amount: entry.refund,
      notes: { order: String(claimed.number), cancellation: cancellationId.toString() },
    });
    result = {
      $set: {
        'cancellations.$.refundStatus': 'refunded',
        'cancellations.$.refundId': refund.id,
        'cancellations.$.refundedAt': new Date(),
      },
      $unset: { 'cancellations.$.refundError': '' },
    };
  } catch (err) {
    result = {
      $set: {
        'cancellations.$.refundStatus': 'refund_failed',
        'cancellations.$.refundError': refundErrorText(err, entry.refund),
      },
    };
  }
  return orders.findOneAndUpdate({ _id: orderId, 'cancellations._id': cancellationId }, result, {
    returnDocument: 'after',
  });
}

// Cancels `body.items` of the order matching `filter` (or, with `preview`, only says what that would do). In one
// transaction: the order (status `placed` in the filter, so a shipment or cancellation meanwhile wins), the stock put
// back with its history, and any credit given back. Returns { order, entry } or { preview }.
async function cancelItems(ctx, filter, body, user, role) {
  const { db, client } = ctx;
  const orders = db.collection('orders');
  const check = (order) => {
    if (!order) throw new HttpError(404, 'Order not found');
    if (order.status !== 'placed') {
      throw new HttpError(409, `Items can only be cancelled before the order ships; this one is ${order.status}`);
    }
    if ((order.cancellations?.length ?? 0) >= MAX_CANCELLATIONS) {
      throw new HttpError(409, `Items of this order have been cancelled ${MAX_CANCELLATIONS} times already`);
    }
  };
  if (body.preview) {
    const order = await orders.findOne(filter);
    check(order);
    return { preview: toPlan(order, cancellationPlan(order, body.items)) };
  }
  const { order, entry } = await inTransaction(client, async (session) => {
    const order = await orders.findOne(filter, { session });
    check(order);
    const plan = cancellationPlan(order, body.items);
    const now = new Date();
    const entry = {
      _id: new ObjectId(),
      items: plan.cancelled,
      amount: plan.amount,
      refund: plan.refund,
      creditBack: plan.creditBack,
      refundStatus: plan.refund ? 'pending' : 'none',
      role,
      // Admins only: the customer is the order's.
      by: role === 'admin' ? byOf(user) : null,
      at: now,
    };
    const after = await orders.findOneAndUpdate(
      { _id: order._id, status: 'placed' },
      {
        $set: {
          items: plan.items,
          subtotal: plan.subtotal,
          discount: plan.discount,
          total: plan.total,
          ...(order.creditUsed && { creditUsed: plan.creditUsed }),
          ...(order.bundleSaving && { bundleSaving: plan.bundleSaving }),
          updatedAt: now,
        },
        $push: { cancellations: entry },
      },
      { session, returnDocument: 'after' },
    );
    if (!after) throw new HttpError(409, 'The order changed meanwhile. Reload the page and try again.');
    const entries = [];
    for (const i of plan.cancelled) {
      const product = await db
        .collection('products')
        .findOneAndUpdate(
          i.variantId ? { _id: i.productId, 'variants._id': i.variantId } : { _id: i.productId },
          i.variantId
            ? { $inc: { stock: i.qty, 'variants.$.stock': i.qty }, $set: { updatedAt: now } }
            : { $inc: { stock: i.qty }, $set: { updatedAt: now } },
          { session, returnDocument: 'after' },
        );
      if (product) {
        entries.push(
          movedEntry(product, i.variantId, i.qty, {
            reason: CANCEL_REASONS[role === 'admin' ? 'admin' : 'customer'],
            orderId: order._id,
            orderNumber: order.number ?? null,
            by: byOf(role === 'admin' ? user : null),
            at: now,
          }),
        );
      }
    }
    await recordStock(db, entries, session);
    if (plan.creditBack) {
      await addCredit(
        db,
        order.userId,
        plan.creditBack,
        {
          reason: 'cancelled',
          orderId: order._id,
          orderNumber: order.number ?? null,
          by: byOf(role === 'admin' ? user : null),
        },
        session,
      );
    }
    return { order: after, entry };
  });
  const result = entry.refund ? await refundCancellation(ctx, order._id, entry._id) : order;
  const saved = result.cancellations.find((c) => c._id.equals(entry._id));
  await sendItemsCancelled(ctx, result, saved, role === 'admin');
  return { order: result, entry: saved };
}

const logCancellation = (db, user, order, entry, action) =>
  logActivity(db, user, {
    area: 'orders',
    action,
    target: { label: orderLabel(order), path: `/admin/orders/${order._id}` },
    changes: [
      ...entry.items.map((i) => ({ field: i.title, to: `${i.qty} cancelled` })),
      { field: 'Total', to: rupees(order.total) },
      ...(entry.refund
        ? [{ field: 'Refund', to: `${rupees(entry.refund)} (${entry.refundStatus.replace('_', ' ')})` }]
        : []),
      ...(entry.creditBack ? [{ field: 'Store credit back', to: rupees(entry.creditBack) }] : []),
    ],
  });

export function itemCancellationRouter(ctx) {
  const { db } = ctx;
  const router = express.Router();

  router.post('/orders/:id/cancel-items', requireUser, async (req, res) => {
    const body = parse(cancelBody, req.body);
    const filter = { _id: parseObjectId(req.params.id, 'order id'), userId: req.user._id };
    const result = await cancelItems(ctx, filter, body, req.user, 'customer');
    res.json(result.preview ? result : toOrder(result.order));
  });

  router.post('/admin/orders/:id/cancel-items', requireAdmin, async (req, res) => {
    const body = parse(cancelBody, req.body);
    const filter = { _id: parseObjectId(req.params.id, 'order id') };
    const result = await cancelItems(ctx, filter, body, req.user, 'admin');
    if (result.preview) return res.json(result);
    await logCancellation(db, req.user, result.order, result.entry, 'Cancelled items');
    res.json(toOrder(result.order, { admin: true }));
  });

  // Tries a cancellation's part refund again after Razorpay refused it.
  router.post('/admin/orders/:id/cancellations/:cancellationId/refund', requireAdmin, async (req, res) => {
    const orderId = parseObjectId(req.params.id, 'order id');
    const cancellationId = parseObjectId(req.params.cancellationId, 'cancellation id');
    const order = await db.collection('orders').findOne({ _id: orderId });
    const entry = order?.cancellations?.find((c) => c._id.equals(cancellationId));
    if (!entry) throw new HttpError(404, 'Cancellation not found');
    if (entry.refundStatus !== 'refund_failed') {
      throw new HttpError(409, 'Only a cancellation whose refund failed can be retried');
    }
    const after = await refundCancellation(ctx, orderId, cancellationId);
    const saved = after.cancellations.find((c) => c._id.equals(cancellationId));
    await logCancellation(db, req.user, after, saved, 'Retried cancellation refund');
    res.json(toOrder(after, { admin: true }));
  });

  return router;
}
