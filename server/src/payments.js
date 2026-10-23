import { sendNewOrderAlert, sendOrderEmail } from './emails.js';
import { HttpError } from './http.js';

// Online payments (Razorpay, test mode). An online order is created as `awaiting_payment` with its stock already
// reserved; it becomes `placed` once Razorpay confirms the payment, or is cancelled (stock returned) when the
// payment window runs out. order.payment is { method: 'cod' } or
// { method: 'razorpay', status: 'pending' | 'paid' | 'refunding' | 'refunded' | 'refund_failed', razorpayOrderId,
//   razorpayPaymentId, paidAt, refundId, refundedAt, refundError }.

export const PAYMENT_WINDOW_MS = 30 * 60_000;

// What the browser needs to open Razorpay's checkout for an order.
export const checkoutParams = (razorpay, order, user) => ({
  keyId: razorpay.keyId,
  orderId: order.payment.razorpayOrderId,
  amount: order.total,
  currency: 'INR',
  expiresAt: order.expiresAt,
  prefill: { name: user.name, email: user.email, contact: order.address.phone },
});

// Marks an awaiting order paid, given a Razorpay payment entity for it. Safe to call more than once for the same
// payment (the browser, the webhook and "check again" can all report it). Returns the current order document.
export async function confirmPayment(ctx, order, payment) {
  const { db, razorpay } = ctx;
  const orders = db.collection('orders');
  if (payment.order_id !== order.payment?.razorpayOrderId)
    throw new HttpError(400, 'This payment is for another order');
  if (payment.amount !== order.total) throw new HttpError(400, 'The payment amount does not match the order');
  if (payment.status === 'authorized') payment = await razorpay.capture(payment.id, payment.amount);
  if (payment.status !== 'captured') throw new HttpError(400, 'The payment did not go through. You can try again.');

  const now = new Date();
  const paid = {
    'payment.status': 'paid',
    'payment.razorpayPaymentId': payment.id,
    'payment.paidAt': now,
    updatedAt: now,
  };
  const placed = await orders.findOneAndUpdate(
    { _id: order._id, status: 'awaiting_payment' },
    { $set: { status: 'placed', ...paid }, $unset: { expiresAt: '' } },
    { returnDocument: 'after' },
  );
  if (placed) {
    // Only the call that moved the order to placed gets here, so the confirmation goes out once.
    await sendOrderEmail(ctx, placed, 'placed');
    await sendNewOrderAlert(ctx, placed);
    return placed;
  }

  const current = await orders.findOne({ _id: order._id });
  // Money arrived for an order that had already expired or been cancelled (its stock is gone): give it back.
  if (current.status === 'cancelled' && current.payment.status === 'pending') {
    const recorded = await orders.findOneAndUpdate(
      { _id: order._id, 'payment.status': 'pending' },
      { $set: paid },
      { returnDocument: 'after' },
    );
    if (recorded) return refundPayment({ db, razorpay }, recorded);
  }
  return current;
}

// Asks Razorpay whether an awaiting order has been paid (for when the browser never reported back).
export async function syncPayment(ctx, order) {
  if (order.status !== 'awaiting_payment' || !order.payment?.razorpayOrderId || !ctx.razorpay) return order;
  const payments = await ctx.razorpay.orderPayments(order.payment.razorpayOrderId);
  const payment = payments.find((p) => p.status === 'captured') ?? payments.find((p) => p.status === 'authorized');
  return payment ? confirmPayment(ctx, order, payment) : order;
}

// What an admin sees when a refund fails. Razorpay pays refunds from the account balance, which is short of the
// payment by its fee, so a refund it refuses is most often a balance problem (its reply just says "invalid request").
export function refundErrorText(err, amount) {
  if (!err.razorpayReason) return err.message;
  const rupees = (amount / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return `Razorpay refused the refund ("${err.razorpayReason}"). Check that your Razorpay balance covers ₹${rupees}, then retry.`;
}

// Refunds the full amount of a paid (or failed-to-refund) online order. Only one caller gets to refund: the status
// is claimed first. Failures are recorded on the order, so an admin can retry. Returns the current order document.
export async function refundPayment({ db, razorpay }, order) {
  const orders = db.collection('orders');
  const claimed = await orders.findOneAndUpdate(
    { _id: order._id, 'payment.method': 'razorpay', 'payment.status': { $in: ['paid', 'refund_failed'] } },
    { $set: { 'payment.status': 'refunding' } },
    { returnDocument: 'after' },
  );
  if (!claimed) return orders.findOne({ _id: order._id });
  let result;
  try {
    if (!razorpay) throw new Error('Online payments are not configured on this server');
    const refund = await razorpay.refund(claimed.payment.razorpayPaymentId, {
      amount: claimed.total,
      notes: { order: String(claimed.number) },
    });
    result = {
      $set: { 'payment.status': 'refunded', 'payment.refundId': refund.id, 'payment.refundedAt': new Date() },
      $unset: { 'payment.refundError': '' },
    };
  } catch (err) {
    result = {
      $set: { 'payment.status': 'refund_failed', 'payment.refundError': refundErrorText(err, claimed.total) },
    };
  }
  return orders.findOneAndUpdate({ _id: order._id }, result, { returnDocument: 'after' });
}
