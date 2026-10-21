import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { HttpError, parse, parseObjectId } from '../http.js';
import { toProductCard } from './catalog.js';

// Amounts in paise. Delivery is free from ₹499 of items, otherwise ₹40.
export const FREE_DELIVERY_MIN = 49900;
export const DELIVERY_FEE = 4000;
export const MAX_QTY = 10;
export const MAX_CART_ITEMS = 20;

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

const address = z.object({
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
});

const toOrder = (doc) => ({
  id: doc._id.toString(),
  items: doc.items.map((i) => ({ ...i, productId: i.productId.toString() })),
  subtotal: doc.subtotal,
  delivery: doc.delivery,
  total: doc.total,
  address: doc.address,
  payment: doc.payment,
  status: doc.status,
  createdAt: doc.createdAt,
  cancelledAt: doc.cancelledAt ?? null,
});

export function ordersRouter({ db, client }) {
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
        order = {
          userId: req.user._id,
          items,
          ...totals,
          address: body.address,
          payment: 'cod',
          status: 'placed',
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
    res.status(201).json(toOrder(order));
  });

  router.get('/orders', requireUser, async (req, res) => {
    const docs = await orders.find({ userId: req.user._id }).sort({ createdAt: -1, _id: -1 }).limit(100).toArray();
    res.json(docs.map(toOrder));
  });

  router.get('/orders/:id', requireUser, async (req, res) => {
    // Someone else's order is reported as not found, so ids can't be probed.
    const doc = await orders.findOne({ _id: parseObjectId(req.params.id, 'order id'), userId: req.user._id });
    if (!doc) throw new HttpError(404, 'Order not found');
    res.json(toOrder(doc));
  });

  router.post('/orders/:id/cancel', requireUser, async (req, res) => {
    const _id = parseObjectId(req.params.id, 'order id');
    const session = client.startSession();
    let order;
    try {
      await session.withTransaction(async () => {
        const now = new Date();
        order = await orders.findOneAndUpdate(
          { _id, userId: req.user._id, status: 'placed' },
          { $set: { status: 'cancelled', cancelledAt: now, updatedAt: now } },
          { session, returnDocument: 'after' },
        );
        if (!order) {
          const existing = await orders.findOne({ _id, userId: req.user._id }, { session });
          if (!existing) throw new HttpError(404, 'Order not found');
          throw new HttpError(409, `This order can't be cancelled (it is ${existing.status})`);
        }
        await products.bulkWrite(
          order.items.map((i) => ({
            updateOne: { filter: { _id: i.productId }, update: { $inc: { stock: i.qty }, $set: { updatedAt: now } } },
          })),
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    res.json(toOrder(order));
  });

  return router;
}
