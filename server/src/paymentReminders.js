import { paymentReminderEmail } from './emails.js';
import { syncPayment } from './payments.js';

// Payment reminders (stage 103): an online order still `awaiting_payment` REMIND_AFTER_MS after it was placed gets one
// email with a link back to its Pay now, while at least MIN_LEFT_MS of its payment window remains (stock is held
// for 30 minutes, then expireUnpaidOrders cancels it). Razorpay is asked first (syncPayment), so a customer who paid
// but whose browser never reported back gets their confirmation, not a reminder. Each order is claimed by setting
// `paymentReminder` { at } (missing and the status in the filter, so simultaneous sweeps send once); a failed email
// removes it for the next sweep, while there's still time.
export const REMIND_AFTER_MS = 10 * 60_000;
export const MIN_LEFT_MS = 5 * 60_000;

// Run every minute by index.js (and directly by tests, with `now`). Returns the number sent.
export async function sendPaymentReminders(ctx, now = new Date()) {
  const orders = ctx.db.collection('orders');
  const due = await orders
    .find({
      status: 'awaiting_payment',
      paymentReminder: { $exists: false },
      createdAt: { $lte: new Date(now - REMIND_AFTER_MS) },
      expiresAt: { $gt: new Date(now.getTime() + MIN_LEFT_MS) },
    })
    .limit(50)
    .toArray();
  let sent = 0;
  for (const found of due) {
    const order = await syncPayment(ctx, found).catch(() => found); // Razorpay unreachable: remind anyway
    if (order.status !== 'awaiting_payment') continue; // paid after all
    const claimed = await orders.updateOne(
      { _id: order._id, status: 'awaiting_payment', paymentReminder: { $exists: false } },
      { $set: { paymentReminder: { at: now } } },
    );
    if (!claimed.modifiedCount) continue;
    const user = await ctx.db.collection('users').findOne({ _id: order.userId }, { projection: { name: 1, email: 1 } });
    if (!user) continue;
    try {
      const email = paymentReminderEmail(order, user, ctx.config.mail?.publicUrl);
      await ctx.mail.send({ to: { email: user.email, name: user.name }, ...email });
      sent++;
    } catch (err) {
      console.error(`Could not send a payment reminder for order ${order._id}:`, err.message);
      await orders.updateOne({ _id: order._id, 'paymentReminder.at': now }, { $unset: { paymentReminder: '' } });
    }
  }
  return sent;
}
