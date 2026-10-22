import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { sendOrderEmail } from '../emails.js';
import { HttpError, parse, parseObjectId } from '../http.js';
import { checkoutParams, PAYMENT_WINDOW_MS, refundPayment, syncPayment } from '../payments.js';
import { toProductCard } from './catalog.js';

// Amounts in paise. Delivery is free from ₹499 of items, otherwise ₹40.
export const FREE_DELIVERY_MIN = 49900;
export const DELIVERY_FEE = 4000;
export const MAX_QTY = 10;
export const MAX_CART_ITEMS = 20;
export const ORDER_STATUSES = ['awaiting_payment', 'placed', 'shipped', 'delivered', 'cancelled'];

// Order numbers count up from here: #100001, #100002, …
const FIRST_ORDER_NUMBER = 100001;

export const orderTotals = (subtotal) => {
  const delivery = subtotal >= FREE_DELIVERY_MIN ? 0 : DELIVERY_FEE;
  return { subtotal, delivery, total: subtotal + delivery };
};

const cartItems = z
  .array(
    z.object({
      productId: z.string().regex(/^[0-9a-f]{24}$/, 'Invalid product id'),
      qty: z.number().int().min(1).max(MAX_QTY),
    }),
  )
  .min(1, 'Your cart is empty')
  .max(MAX_CART_ITEMS)
  .refine((items) => new Set(items.map((i) => i.productId)).size === items.length, 'Duplicate product in cart');

// GET /cart?items=<productId>:<qty>,<productId>:<qty>
const quoteQuery = z.object({
  items: z
    .string()
    .max(1000)
    .transform((s) =>
      s
        .split(',')
        .filter(Boolean)
        .map((part) => {
          const [productId, qty] = part.split(':');
          return { productId, qty: Number(qty) };
        }),
    )
    .pipe(cartItems),
});

// Also used by the account page's saved address.
export const address = z.object({
  name: z.string().trim().min(1, 'Enter the recipient name').max(80),
  phone: z
    .string()
    .trim()
    .regex(/^[6-9]\d{9}$/, 'Enter a 10-digit mobile number'),
  line1: z.string().trim().min(1, 'Enter the address').max(120),
  line2: z.string().trim().max(120).default(''),
  city: z.string().trim().min(1, 'Enter the city').max(60),
  state: z.string().trim().min(1, 'Enter the state').max(60),
  pincode: z
    .string()
    .trim()
    .regex(/^[1-9]\d{5}$/, 'Enter a 6-digit PIN code'),
});

const orderBody = z.object({
  items: cartItems,
  address,
  // The total the customer was shown; if prices changed since, the order is refused rather than charged differently.
  expectedTotal: z.number().int().min(0),
  paymentMethod: z.enum(['cod', 'razorpay']).default('cod'),
});

const withoutRefundError = (payment, admin) => {
  if (admin || !payment.refundError) return payment;
  return { ...payment, refundError: undefined }; // dropped from the JSON
};

// `admin` keeps internal payment details (why a refund failed) that customers don't need to see.
export const toOrder = (doc, { admin = false } = {}) => ({
  id: doc._id.toString(),
  // Orders placed before numbering (stage 2) have none; the client falls back to the end of the id.
  number: doc.number ?? null,
  items: doc.items.map((i) => ({ ...i, productId: i.productId.toString() })),
  subtotal: doc.subtotal,
  delivery: doc.delivery,
  total: doc.total,
  address: doc.address,
  // Orders from before online payments stored just 'cod'.
  payment: typeof doc.payment === 'string' ? { method: doc.payment } : withoutRefundError(doc.payment, admin),
  status: doc.status,
  expiresAt: doc.expiresAt ?? null,
  createdAt: doc.createdAt,
  shippedAt: doc.shippedAt ?? null,
  deliveredAt: doc.deliveredAt ?? null,
  cancelledAt: doc.cancelledAt ?? null,
  cancelledBy: doc.cancelledBy ?? null,
});

// Cancels the order matching `filter` if its status is one of `from`, and puts its stock back, in one transaction.
// A paid online order is then refunded. `by` is 'customer', 'admin' or 'system' (unpaid and expired). The customer
// is emailed unless `notify` is false. Returns the updated order document.
export async function cancelOrder(ctx, filter, { from, by, notify = true }) {
  const { db, client } = ctx;
  const orders = db.collection('orders');
  // An order still awaiting payment may in fact have been paid: settle that first, so a paid order is refunded.
  const before = await orders.findOne(filter);
  if (before?.status === 'awaiting_payment') await syncPayment(ctx, before);
  const session = client.startSession();
  let order;
  try {
    await session.withTransaction(async () => {
      const now = new Date();
      order = await orders.findOneAndUpdate(
        { ...filter, status: { $in: from } },
        { $set: { status: 'cancelled', cancelledAt: now, cancelledBy: by, updatedAt: now } },
        { session, returnDocument: 'after' },
      );
      if (!order) {
        const existing = await orders.findOne(filter, { session });
        if (!existing) throw new HttpError(404, 'Order not found');
        throw new HttpError(409, `This order can't be cancelled (it is ${existing.status})`);
      }
      await db.collection('products').bulkWrite(
        order.items.map((i) => ({
          updateOne: { filter: { _id: i.productId }, update: { $inc: { stock: i.qty }, $set: { updatedAt: now } } },
        })),
        { session },
      );
    });
  } finally {
    await session.endSession();
  }
  const result = order.payment?.status === 'paid' ? await refundPayment(ctx, order) : order;
  if (notify) await sendOrderEmail(ctx, result, 'cancelled');
  return result;
}

// Cancels an awaiting-payment order whose payment window has passed, unless Razorpay says it was paid after all.
export async function expireOrder(ctx, order) {
  try {
    return await cancelOrder(ctx, { _id: order._id }, { from: ['awaiting_payment'], by: 'system' });
  } catch (err) {
    if (err.status === 409) return ctx.db.collection('orders').findOne({ _id: order._id }); // paid or cancelled meanwhile
    throw err;
  }
}

// Run every minute by index.js (and directly by tests).
export async function expireUnpaidOrders(ctx) {
  const due = await ctx.db
    .collection('orders')
    .find({ status: 'awaiting_payment', expiresAt: { $lte: new Date() } })
    .limit(100)
    .toArray();
  for (const order of due) {
    try {
      await expireOrder(ctx, order);
    } catch (err) {
      console.error(`Could not expire order ${order._id}:`, err.message); // retried next minute
    }
  }
  return due.length;
}

export function ordersRouter(ctx) {
  const { db, client, razorpay } = ctx;
  const products = db.collection('products');
  const orders = db.collection('orders');
  const users = db.collection('users');
  const router = express.Router();

  // Current prices and stock for a cart kept in the browser. Works for guests.
  router.get('/cart', async (req, res) => {
    const { items } = parse(quoteQuery, req.query);
    const docs = await products
      .find({ _id: { $in: items.map((i) => new ObjectId(i.productId)) }, active: true })
      .toArray();
    const byId = new Map(docs.map((d) => [d._id.toString(), d]));
    const lines = items.map(({ productId, qty }) => {
      const doc = byId.get(productId);
      if (!doc) return { productId, qty, product: null, lineTotal: 0, problem: 'No longer available' };
      const problem = doc.stock === 0 ? 'Out of stock' : doc.stock < qty ? `Only ${doc.stock} left` : null;
      return { productId, qty, product: toProductCard(doc), lineTotal: doc.price * qty, problem };
    });
    const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
    res.json({
      items: lines,
      ...orderTotals(subtotal),
      freeDeliveryMin: FREE_DELIVERY_MIN,
      canCheckout: lines.every((l) => !l.problem),
    });
  });

  router.post('/orders', requireUser, async (req, res) => {
    const body = parse(orderBody, req.body);
    const online = body.paymentMethod === 'razorpay';
    if (online && !razorpay) throw new HttpError(400, 'Online payment is not available. Choose Cash on Delivery.');
    const session = client.startSession();
    let order;
    try {
      await session.withTransaction(async () => {
        const now = new Date();
        const items = [];
        for (const { productId, qty } of body.items) {
          const _id = new ObjectId(productId);
          // The stock check is part of the update, so two buyers can't both take the last unit.
          const doc = await products.findOneAndUpdate(
            { _id, active: true, stock: { $gte: qty } },
            { $inc: { stock: -qty }, $set: { updatedAt: now } },
            { session },
          );
          if (!doc) {
            const current = await products.findOne({ _id, active: true }, { session });
            throw new HttpError(
              409,
              !current
                ? 'An item in your cart is no longer available'
                : current.stock === 0
                  ? `${current.title} is out of stock`
                  : `Only ${current.stock} left of ${current.title}`,
            );
          }
          items.push({
            productId: _id,
            slug: doc.slug,
            title: doc.title,
            brand: doc.brand,
            image: doc.images[0] ?? null,
            price: doc.price,
            qty,
          });
        }
        const totals = orderTotals(items.reduce((sum, i) => sum + i.price * i.qty, 0));
        if (totals.total !== body.expectedTotal) {
          throw new HttpError(409, 'Prices have changed since you loaded the page. Please review your order.');
        }
        // Taken inside the transaction: a failed order gives its number back, so numbers have no gaps or repeats.
        const counter = await db
          .collection('counters')
          .findOneAndUpdate(
            { _id: 'orderNumber' },
            { $inc: { seq: 1 } },
            { session, upsert: true, returnDocument: 'after' },
          );
        order = {
          number: FIRST_ORDER_NUMBER - 1 + counter.seq,
          userId: req.user._id,
          items,
          ...totals,
          address: body.address,
          // Online orders hold their stock while the customer pays; expireUnpaidOrders releases it if they don't.
          payment: online ? { method: 'razorpay', status: 'pending' } : { method: 'cod' },
          status: online ? 'awaiting_payment' : 'placed',
          ...(online && { expiresAt: new Date(now.getTime() + PAYMENT_WINDOW_MS) }),
          createdAt: now,
          updatedAt: now,
        };
        const { insertedId } = await orders.insertOne(order, { session });
        order._id = insertedId;
        await users.updateOne({ _id: req.user._id }, { $set: { address: body.address } }, { session });
      });
    } finally {
      await session.endSession();
    }
    if (!online) {
      await sendOrderEmail(ctx, order, 'placed');
      return res.status(201).json({ ...toOrder(order), checkout: null });
    }

    // Outside the transaction: a network call. If Razorpay can't take the order, ours is cancelled and stock returned.
    try {
      const rzpOrder = await razorpay.createOrder({
        amount: order.total,
        receipt: `order_${order.number}`,
        notes: { orderId: order._id.toString() },
      });
      order.payment.razorpayOrderId = rzpOrder.id;
      await orders.updateOne({ _id: order._id }, { $set: { 'payment.razorpayOrderId': rzpOrder.id } });
    } catch (err) {
      // The customer sees the error straight away, so no cancellation email for an order they never saw.
      await cancelOrder(ctx, { _id: order._id }, { from: ['awaiting_payment'], by: 'system', notify: false });
      throw err;
    }
    res.status(201).json({ ...toOrder(order), checkout: checkoutParams(razorpay, order, req.user) });
  });

  router.get('/orders', requireUser, async (req, res) => {
    const docs = await orders.find({ userId: req.user._id }).sort({ createdAt: -1, _id: -1 }).limit(100).toArray();
    res.json(docs.map(toOrder));
  });

  router.get('/orders/:id', requireUser, async (req, res) => {
    // Someone else's order is reported as not found, so ids can't be probed.
    let doc = await orders.findOne({ _id: parseObjectId(req.params.id, 'order id'), userId: req.user._id });
    if (!doc) throw new HttpError(404, 'Order not found');
    // Don't show a lapsed payment window as still open while waiting for the next sweep.
    if (doc.status === 'awaiting_payment' && doc.expiresAt <= new Date()) doc = await expireOrder(ctx, doc);
    res.json(toOrder(doc));
  });

  router.post('/orders/:id/cancel', requireUser, async (req, res) => {
    const filter = { _id: parseObjectId(req.params.id, 'order id'), userId: req.user._id };
    // Customers can cancel only until the order ships (or while it still awaits payment).
    const order = await cancelOrder(ctx, filter, { from: ['awaiting_payment', 'placed'], by: 'customer' });
    res.json(toOrder(order));
  });

  return router;
}
