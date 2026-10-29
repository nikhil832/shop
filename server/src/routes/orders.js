import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { couponDiscount, redeemCoupon, releaseCoupon } from '../coupons.js';
import { sendNewOrderAlert, sendOrderEmail } from '../emails.js';
import { HttpError, parse, parseObjectId } from '../http.js';
import { checkoutParams, PAYMENT_WINDOW_MS, refundPayment, syncPayment } from '../payments.js';
import { findVariant, imageFor, variantDescription, variantTitle } from '../variants.js';
import { toProductCard } from './catalog.js';
import { deliveryFor, istDate } from './delivery.js';
import { findState, gstForOrders, gstInvoice } from '../gst.js';
import { rememberAddress } from '../addressBook.js';
import { byOf, CANCEL_REASONS, movedEntry, recordStock } from '../stockHistory.js';
import { addCredit, amountDue } from '../credit.js';
import { codAllowed } from '../cod.js';
import { applyBundles, bundlesFor } from '../bundles.js';
import { cashbackOn, cashbackSettings } from '../cashback.js';
import { friendDiscount } from '../referrals.js';

// Amounts in paise. Delivery is free from ₹499 of items, otherwise ₹40.
export const FREE_DELIVERY_MIN = 49900;
export const DELIVERY_FEE = 4000;
export const MAX_QTY = 10;
export const MAX_CART_ITEMS = 20;
export const ORDER_STATUSES = ['awaiting_payment', 'placed', 'shipped', 'delivered', 'cancelled'];

// Order numbers count up from here: #100001, #100002, …
const FIRST_ORDER_NUMBER = 100001;

// Totals after a coupon's discount (paise; at most the items plus delivery).
const withDiscount = (totals, discount) => ({ ...totals, discount, total: totals.total - discount });

export const orderTotals = (subtotal) => {
  const delivery = subtotal >= FREE_DELIVERY_MIN ? 0 : DELIVERY_FEE;
  return { subtotal, delivery, total: subtotal + delivery };
};

// A cart line: a product, and which variant for a product that has them (e.g. its size).
const lineKey = (i) => (i.variantId ? `${i.productId}.${i.variantId}` : i.productId);
const cartLine = z.object({
  productId: z.string().regex(/^[0-9a-f]{24}$/, 'Invalid product id'),
  variantId: z
    .string()
    .regex(/^[0-9a-f]{24}$/, 'Invalid variant id')
    .optional(),
  qty: z.number().int().min(1).max(MAX_QTY),
});
const eachOnce = (lines) =>
  lines.refine((items) => new Set(items.map(lineKey)).size === items.length, 'Duplicate product in cart');
const cartItems = eachOnce(z.array(cartLine).min(1, 'Your cart is empty').max(MAX_CART_ITEMS));
// What a saved cart holds (routes/savedCart.js): the same lines, and it may be empty.
export const savedCartLines = eachOnce(z.array(cartLine).max(MAX_CART_ITEMS));

// GET /cart?items=<productId>[.<variantId>]:<qty>,…
const quoteQuery = z.object({
  coupon: z.string().trim().max(40).optional(),
  // A friend's referral code (stage 87), for a visitor who'll make their account at checkout.
  ref: z.string().trim().max(20).optional(),
  items: z
    .string()
    .max(1000)
    .transform((s) =>
      s
        .split(',')
        .filter(Boolean)
        .map((part) => {
          const [key, qty] = part.split(':');
          const [productId, variantId] = key.split('.');
          return { productId, ...(variantId && { variantId }), qty: Number(qty) };
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
  // A state or union territory from the list, stored by its proper name ("tamilnadu" → "Tamil Nadu"): GST invoices
  // compare it with the store's state.
  state: z
    .string()
    .trim()
    .min(1, 'Enter the state')
    .max(60)
    .transform((s, ctx) => {
      const found = findState(s);
      if (!found) {
        ctx.addIssue({ code: 'custom', message: 'Choose a state or union territory from the list' });
        return z.NEVER;
      }
      return found.name;
    }),
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
  couponCode: z.string().trim().max(40).optional(),
  // Store credit to spend, in paise, as the customer was shown (stage 72): refused if their balance is lower now.
  creditToUse: z.number().int().min(0).default(0),
  // A new address goes into the customer's address book unless they unticked "Save it" (a saved one is never changed).
  saveAddress: z.boolean().default(true),
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
  // Customers never see what an item cost the store.
  items: doc.items.map(({ cost, ...i }) => ({
    ...i,
    ...(admin && cost !== undefined && { cost }),
    productId: i.productId.toString(),
    ...(i.variantId && { variantId: i.variantId.toString() }),
  })),
  subtotal: doc.subtotal,
  delivery: doc.delivery,
  // Orders from before coupons have no discount.
  discount: doc.discount ?? 0,
  coupon: doc.coupon ?? null,
  total: doc.total,
  // { from, to } India-time dates it should arrive between (stage 86); null on older orders.
  deliveryEstimate: doc.deliveryEstimate ?? null,
  // Whether `discount` is a referred friend's welcome rather than a coupon (stage 87).
  referral: Boolean(doc.referral),
  // Saved by bundles (stage 83): already in the bundled items' prices, so `subtotal` is after it.
  bundleSaving: doc.bundleSaving ?? 0,
  // Paid with store credit (stage 72); `total` less this is what was paid, or is to pay, in money.
  creditUsed: doc.creditUsed ?? 0,
  address: doc.address,
  // When the address was last changed before shipping (stage 90, orderAddress.js); admins also get every earlier one.
  addressChangedAt: doc.addressChanges?.at(-1)?.at ?? null,
  ...(admin && {
    addressChanges: (doc.addressChanges ?? []).map((c) => ({ from: c.from, at: c.at, by: c.by.name, role: c.role })),
  }),
  // Orders from before online payments stored just 'cod'.
  payment: typeof doc.payment === 'string' ? { method: doc.payment } : withoutRefundError(doc.payment, admin),
  status: doc.status,
  expiresAt: doc.expiresAt ?? null,
  createdAt: doc.createdAt,
  shippedAt: doc.shippedAt ?? null,
  // { courier, trackingNumber, trackingUrl } once the admin has entered them.
  shipment: doc.shipment ?? null,
  deliveredAt: doc.deliveredAt ?? null,
  cancelledAt: doc.cancelledAt ?? null,
  cancelledBy: doc.cancelledBy ?? null,
  // A shipped order that came back undelivered (cod.js): why, and when. The admin's note is for admins only.
  returnedToSender: doc.returnedToSender
    ? {
        reason: doc.returnedToSender.reason,
        at: doc.returnedToSender.at,
        ...(admin && { note: doc.returnedToSender.note }),
      }
    : null,
  // The GST lines of its tax invoice, for orders placed with GST on (gst.js); null otherwise.
  gstInvoice: gstInvoice(doc),
  // Admins' private notes (admin.js); never in what a customer gets.
  ...(admin && {
    notes: (doc.notes ?? []).map((n) => ({
      id: n._id.toString(),
      text: n.text,
      onSlip: n.onSlip,
      by: n.by,
      at: n.at,
    })),
  }),
});

// Cancels the order matching `filter` if its status is one of `from`, and puts its stock back, in one transaction.
// A paid online order is then refunded. `by` is 'customer', 'admin' or 'system' (unpaid and expired). The customer
// is emailed unless `notify` is false. `user` is the admin cancelling, for the stock history. Returns the updated order
// document. `returned` { reason, note } (stage 79, cod.js) marks a shipped order that came back undelivered.
export async function cancelOrder(ctx, filter, { from, by, user = null, notify = true, returned = null }) {
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
        {
          $set: {
            status: 'cancelled',
            cancelledAt: now,
            cancelledBy: by,
            updatedAt: now,
            ...(returned && { returnedToSender: { ...returned, at: now } }),
          },
        },
        { session, returnDocument: 'after' },
      );
      if (!order) {
        const existing = await orders.findOne(filter, { session });
        if (!existing) throw new HttpError(404, 'Order not found');
        throw new HttpError(409, `This order can't be cancelled (it is ${existing.status})`);
      }
      // Stock goes back to the variant bought and to the product's total; a variant deleted since gets nothing back.
      const reason = returned ? 'returned_to_sender' : CANCEL_REASONS[by];
      const entries = [];
      for (const i of order.items) {
        const after = await db
          .collection('products')
          .findOneAndUpdate(
            i.variantId ? { _id: i.productId, 'variants._id': i.variantId } : { _id: i.productId },
            i.variantId
              ? { $inc: { stock: i.qty, 'variants.$.stock': i.qty }, $set: { updatedAt: now } }
              : { $inc: { stock: i.qty }, $set: { updatedAt: now } },
            { session, returnDocument: 'after' },
          );
        if (after) {
          entries.push(
            movedEntry(after, i.variantId, i.qty, {
              reason,
              orderId: order._id,
              orderNumber: order.number ?? null,
              by: byOf(user),
              at: now,
            }),
          );
        }
      }
      await recordStock(db, entries, session);
      if (order.coupon) await releaseCoupon(db, order._id, session);
      // Store credit spent on it goes back to the account; money paid goes back by refund, below.
      if (order.creditUsed) {
        await addCredit(
          db,
          order.userId,
          order.creditUsed,
          { reason: 'cancelled', orderId: order._id, orderNumber: order.number ?? null, by: byOf(user) },
          session,
        );
      }
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
    const query = parse(quoteQuery, req.query);
    const { items } = query;
    const docs = await products
      .find({ _id: { $in: items.map((i) => new ObjectId(i.productId)) }, active: true })
      .toArray();
    const byId = new Map(docs.map((d) => [d._id.toString(), d]));
    const lines = items.map(({ productId, variantId = null, qty }) => {
      const doc = byId.get(productId);
      const line = { productId, variantId, qty, variant: null, price: 0, mrp: 0, stock: 0, lineTotal: 0 };
      if (!doc) return { ...line, product: null, problem: 'No longer available' };
      const product = toProductCard(doc);
      if (doc.variants?.length && !variantId) {
        return { ...line, product, problem: `Choose a ${doc.variantName.toLowerCase()}` };
      }
      const variant = variantId ? findVariant(doc, variantId) : null;
      if (variantId && !variant) return { ...line, product, problem: 'No longer available' };
      // The variant's own price, MRP and stock, or the product's.
      const { price, mrp, stock } = variant ?? doc;
      const problem = stock === 0 ? 'Out of stock' : stock < qty ? `Only ${stock} left` : null;
      return {
        ...line,
        product,
        // `description` names it for the cart: "Size: UK 8", or "Colour: Black, Size: 32".
        variant: variant && {
          id: variant._id.toString(),
          name: doc.variantName,
          label: variant.label,
          description: variantDescription(doc, variant),
        },
        image: imageFor(doc, variant),
        price,
        mrp,
        stock,
        lineTotal: price * qty,
        problem,
      };
    });
    const itemsTotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
    // Bundles the cart holds a full set of (bundles.js): their saving comes off before delivery and coupons.
    const buyable = lines.filter((l) => !l.problem);
    const bundled = applyBundles(
      buyable,
      await bundlesFor(
        db,
        buyable.map((l) => l.productId),
      ),
    );
    const totals = orderTotals(itemsTotal - bundled.saving);
    // A coupon that can't be used is reported (couponError), not an error: the quote is still useful.
    let coupon = null;
    let couponError = null;
    if (query.coupon) {
      try {
        const found = await couponDiscount(db, query.coupon, { ...totals, userId: req.user?._id });
        coupon = { code: found.coupon.code, type: found.coupon.type, discount: found.discount };
      } catch (err) {
        if (err.status !== 409) throw err;
        couponError = err.message;
      }
    }
    // A referred friend's first order (stage 87) gets their welcome, unless a coupon is used instead.
    const referral = coupon
      ? 0
      : await friendDiscount(db, { user: req.user, ref: query.ref, subtotal: totals.subtotal });
    const discount = coupon?.discount ?? referral;
    // Cashback this order would earn (stage 85), when it's on: on the items after bundle and coupon savings.
    const cashback = await cashbackSettings(db);
    const itemsPaid = totals.subtotal - (coupon?.type === 'free_delivery' ? 0 : discount);
    res.json({
      items: lines,
      cashback: cashback.enabled ? { amount: cashbackOn(itemsPaid, cashback), percent: cashback.percent } : null,
      // `subtotal` (below) is after bundle savings; `itemsTotal` before them.
      itemsTotal,
      bundles: bundled.applied,
      bundleSaving: bundled.saving,
      ...withDiscount(totals, discount),
      coupon,
      referral: referral ? { discount: referral } : null,
      couponError,
      freeDeliveryMin: FREE_DELIVERY_MIN,
      canCheckout: lines.every((l) => !l.problem),
    });
  });

  router.post('/orders', requireUser, async (req, res) => {
    const body = parse(orderBody, req.body);
    const online = body.paymentMethod === 'razorpay';
    if (online && !razorpay) throw new HttpError(400, 'Online payment is not available. Choose Cash on Delivery.');
    // An address the store doesn't deliver to (Admin → Delivery) is refused before anything is reserved.
    const delivery = await deliveryFor(db, body.address.pincode);
    if (!delivery.deliverable) {
      throw new HttpError(409, `Sorry, we don't deliver to ${body.address.pincode} yet.`);
    }
    const session = client.startSession();
    let order;
    try {
      await session.withTransaction(async () => {
        const now = new Date();
        const items = [];
        const moved = []; // stock history, numbered with the order once it has one
        // With GST on, each item remembers its rate and HSN code, and the order the store's details (gst.js).
        const gst = await gstForOrders(db, session);
        for (const { productId, variantId, qty } of body.items) {
          const _id = new ObjectId(productId);
          const vid = variantId && new ObjectId(variantId);
          // The stock check is part of the update, so two buyers can't both take the last unit. A variant's stock and
          // the product's total go down together. A product with variants can't be bought without choosing one.
          const doc = await products.findOneAndUpdate(
            vid
              ? { _id, active: true, variants: { $elemMatch: { _id: vid, stock: { $gte: qty } } } }
              : { _id, active: true, stock: { $gte: qty }, 'variants.0': { $exists: false } },
            vid
              ? { $inc: { stock: -qty, 'variants.$.stock': -qty }, $set: { updatedAt: now } }
              : { $inc: { stock: -qty }, $set: { updatedAt: now } },
            { session, returnDocument: 'after' },
          );
          if (!doc) {
            const current = await products.findOne({ _id, active: true }, { session });
            const variant = current && vid && findVariant(current, vid);
            const name = current && variantTitle(current, variant);
            const left = variant ? variant.stock : current?.stock;
            throw new HttpError(
              409,
              !current || (vid && !variant)
                ? 'An item in your cart is no longer available'
                : !vid && current.variants?.length
                  ? `Choose a ${current.variantName.toLowerCase()} for ${current.title}`
                  : left === 0
                    ? `${name} is out of stock`
                    : `Only ${left} left of ${name}`,
            );
          }
          const variant = vid ? findVariant(doc, vid) : null;
          moved.push(movedEntry(doc, vid, -qty, { reason: 'ordered', by: null, at: now }));
          items.push({
            productId: _id,
            ...(variant && { variantId: variant._id, variant: variant.label }),
            slug: doc.slug,
            // Snapshotted with the variant in it, so emails, invoices and exports name it as bought.
            title: variantTitle(doc, variant),
            brand: doc.brand,
            image: imageFor(doc, variant),
            price: (variant ?? doc).price,
            // The cost price when sold (stage 80), for profit; admins only (toOrder leaves it out for customers).
            ...((variant ?? doc).cost != null && { cost: (variant ?? doc).cost }),
            qty,
            ...(gst && { gstRate: gst.forCategory(doc.categoryId).rate, hsn: gst.forCategory(doc.categoryId).hsn }),
          });
        }
        // Bundles (bundles.js): units in a full set become their own items at their bundle prices.
        const bundled = applyBundles(
          items.map((i) => ({ productId: i.productId.toString(), variantId: i.variantId, qty: i.qty, price: i.price })),
          await bundlesFor(
            db,
            items.filter((i) => !i.variantId).map((i) => i.productId),
            session,
          ),
        );
        if (bundled.saving) {
          const split = items.flatMap((item, n) =>
            bundled.parts[n].map((part) => ({
              ...item,
              qty: part.qty,
              price: part.price,
              ...(part.bundle && { bundle: part.bundle, regularPrice: part.regularPrice }),
            })),
          );
          items.splice(0, items.length, ...split);
        }
        const before = orderTotals(items.reduce((sum, i) => sum + i.price * i.qty, 0));
        const orderId = new ObjectId();
        let coupon = null;
        let discount = 0;
        if (body.couponCode) {
          ({ coupon, discount } = await couponDiscount(db, body.couponCode, {
            ...before,
            userId: req.user._id,
            session,
          }));
          await redeemCoupon(db, coupon, { userId: req.user._id, orderId, session });
        }
        // A referred customer's first order: the friend's welcome (referrals.js), when no coupon is used.
        let referral = null;
        if (!coupon) {
          const welcome = await friendDiscount(db, { user: req.user, subtotal: before.subtotal });
          if (welcome) {
            discount = welcome;
            referral = { by: req.user.referredBy };
          }
        }
        const totals = withDiscount(before, discount);
        if (totals.total !== body.expectedTotal) {
          throw new HttpError(409, 'Prices have changed since you loaded the page. Please review your order.');
        }
        if (body.creditToUse > totals.total) throw new HttpError(400, 'creditToUse: More than the order costs');
        // All paid with credit: nothing to pay online or on delivery.
        const paidByCredit = body.creditToUse === totals.total;
        // Cash on Delivery's limits (cod.js): an order value, and customers whose COD orders keep coming back.
        if (!online && !paidByCredit) {
          const cod = await codAllowed(db, req.user, totals.total - body.creditToUse);
          if (!cod.allowed) throw new HttpError(409, cod.reason);
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
          _id: orderId,
          number: FIRST_ORDER_NUMBER - 1 + counter.seq,
          userId: req.user._id,
          items,
          ...totals,
          // What was applied, kept with the order like its prices (the coupon itself may change later).
          ...(coupon && { coupon: { code: coupon.code, type: coupon.type } }),
          address: body.address,
          // Delivery goes with the goods, so it's taxed at the order's highest rate.
          ...(gst && { gst: { ...gst.store, deliveryRate: Math.max(...items.map((i) => i.gstRate)) } }),
          // Online orders hold their stock while the customer pays; expireUnpaidOrders releases it if they don't.
          ...(body.creditToUse && { creditUsed: body.creditToUse }),
          ...(bundled.saving && { bundleSaving: bundled.saving }),
          // Its discount is a referred friend's welcome (stage 87); the referrer's reward is set later.
          ...(referral && { referral }),
          // When it should arrive (stage 86), from the delivery area's days, kept as promised at the time.
          deliveryEstimate: { from: istDate(now, delivery.minDays), to: istDate(now, delivery.maxDays) },
          payment: paidByCredit
            ? { method: 'credit' }
            : online
              ? { method: 'razorpay', status: 'pending' }
              : { method: 'cod' },
          status: online && !paidByCredit ? 'awaiting_payment' : 'placed',
          ...(online && !paidByCredit && { expiresAt: new Date(now.getTime() + PAYMENT_WINDOW_MS) }),
          createdAt: now,
          updatedAt: now,
        };
        await orders.insertOne(order, { session });
        // The balance check is in the update, so two orders at once can't spend the same credit.
        await addCredit(
          db,
          req.user._id,
          -body.creditToUse,
          { reason: 'spent', orderId, orderNumber: order.number },
          session,
        );
        await recordStock(
          db,
          moved.map((m) => ({ ...m, orderId, orderNumber: order.number })),
          session,
        );
        if (body.saveAddress) await rememberAddress(users, req.user._id, body.address, { session });
      });
    } finally {
      await session.endSession();
    }
    if (order.status === 'placed') {
      await sendOrderEmail(ctx, order, 'placed');
      await sendNewOrderAlert(ctx, order);
      return res.status(201).json({ ...toOrder(order), checkout: null });
    }

    // Outside the transaction: a network call. If Razorpay can't take the order, ours is cancelled and stock returned.
    try {
      const rzpOrder = await razorpay.createOrder({
        amount: amountDue(order),
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
