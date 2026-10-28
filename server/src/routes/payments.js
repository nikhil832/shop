import express from 'express';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { HttpError, parse, parseObjectId } from '../http.js';
import { checkoutParams, confirmPayment, syncPayment } from '../payments.js';
import { expireOrder, toOrder } from './orders.js';
import { confirmGiftCard } from '../giftCards.js';

// What Razorpay's checkout hands back to the browser after a successful payment.
const paymentBody = z.object({
  razorpay_order_id: z.string().max(100),
  razorpay_payment_id: z.string().max(100),
  razorpay_signature: z.string().max(200),
});

const WEBHOOK_EVENTS = new Set(['payment.captured', 'order.paid']);

export function paymentsRouter(ctx) {
  const { db, razorpay } = ctx;
  const orders = db.collection('orders');
  const router = express.Router();

  async function ownOrder(req) {
    const doc = await orders.findOne({ _id: parseObjectId(req.params.id, 'order id'), userId: req.user._id });
    if (!doc) throw new HttpError(404, 'Order not found');
    return doc;
  }

  // Which payment methods checkout should offer.
  router.get('/payments/options', (req, res) => {
    res.json({ cod: true, online: Boolean(razorpay) });
  });

  // Opens (or reopens) payment for an order that is still awaiting it, e.g. after the customer closed the popup.
  router.post('/orders/:id/pay', requireUser, async (req, res) => {
    if (!razorpay) throw new HttpError(400, 'Online payment is not available right now');
    let order = await ownOrder(req);
    if (order.status === 'awaiting_payment' && order.expiresAt <= new Date()) order = await expireOrder(ctx, order);
    if (order.status === 'awaiting_payment') order = await syncPayment(ctx, order);
    if (order.status !== 'awaiting_payment') {
      throw new HttpError(
        409,
        order.status === 'cancelled' ? 'The time to pay for this order has run out' : 'This order is already paid',
      );
    }
    res.json({ ...toOrder(order), checkout: checkoutParams(razorpay, order, req.user) });
  });

  // The browser reports a payment; only Razorpay's signature (made with our secret) makes it count.
  router.post('/orders/:id/payment', requireUser, async (req, res) => {
    const body = parse(paymentBody, req.body);
    const order = await ownOrder(req);
    if (!razorpay || order.payment?.method !== 'razorpay') throw new HttpError(400, 'This order is not paid online');
    const genuine =
      body.razorpay_order_id === order.payment.razorpayOrderId &&
      razorpay.verifyPayment({
        orderId: order.payment.razorpayOrderId,
        paymentId: body.razorpay_payment_id,
        signature: body.razorpay_signature,
      });
    if (!genuine) throw new HttpError(400, 'The payment could not be verified');
    const payment = await razorpay.fetchPayment(body.razorpay_payment_id);
    res.json(toOrder(await confirmPayment(ctx, order, payment)));
  });

  // "I've paid but the page didn't update": ask Razorpay directly.
  router.post('/orders/:id/payment/check', requireUser, async (req, res) => {
    const order = await ownOrder(req);
    res.json(toOrder(await syncPayment(ctx, order)));
  });

  // Razorpay calls this after a payment, even if the customer closed the tab. Needs RAZORPAY_WEBHOOK_SECRET.
  router.post('/razorpay/webhook', async (req, res) => {
    if (!razorpay?.webhooksEnabled) throw new HttpError(404, 'Not found');
    if (!razorpay.verifyWebhook(req.rawBody, req.get('X-Razorpay-Signature'))) {
      throw new HttpError(400, 'Invalid signature');
    }
    const event = req.body;
    const payment = event.payload?.payment?.entity;
    if (WEBHOOK_EVENTS.has(event.event) && payment?.order_id) {
      const order = await orders.findOne({ 'payment.razorpayOrderId': payment.order_id });
      // Or a gift card's payment (giftCards.js), confirmed the same way.
      const card =
        !order && (await db.collection('giftCards').findOne({ 'payment.razorpayOrderId': payment.order_id }));
      if (order || card) {
        try {
          await (order ? confirmPayment(ctx, order, payment) : confirmGiftCard(ctx, card, payment));
        } catch (err) {
          // A 4xx means the event doesn't fit the order (wrong amount etc.): retrying won't help, so acknowledge it.
          if (!(err.status < 500)) throw err;
          console.error(
            `Webhook ${event.event} for ${order ? 'order' : 'gift card'} ${(order ?? card)._id} ignored:`,
            err.message,
          );
        }
      }
    }
    // Acknowledge anything correctly signed, so Razorpay doesn't keep retrying events we don't use.
    res.json({ ok: true });
  });

  return router;
}
