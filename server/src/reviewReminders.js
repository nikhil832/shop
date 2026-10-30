import { reviewReminderEmail } from './emails.js';

const DAY = 24 * 60 * 60 * 1000;
// Asked this long after delivery, so there's been time to use what came.
export const REMIND_AFTER_DAYS = 3;
// Deliveries older than this are never asked about (including those from before this stage).
export const REMIND_WITHIN_DAYS = 14;
// At most this many products listed in one email.
const MAX_PRODUCTS = 10;

// Run every minute by index.js (and directly by tests, with `now`). Emails each customer once per delivered order,
// REMIND_AFTER_DAYS after delivery, asking them to review its products, leaving out products they have already
// reviewed, products now hidden, and lines returned in full (returns not declined). Each order is claimed by setting
// `reviewReminder` (missing in the filter, so simultaneous sweeps send once); it stays set when there's nothing to ask
// or the customer switched these emails off (users.reviewReminderEmails: false), so the order isn't looked at again,
// and is removed if the email fails, for the next sweep. Returns the number sent.
export async function sendReviewReminders(ctx, now = new Date()) {
  const { db } = ctx;
  const orders = db.collection('orders');
  const due = await orders
    .find({
      status: 'delivered',
      reviewReminder: { $exists: false },
      deliveredAt: { $lte: new Date(now - REMIND_AFTER_DAYS * DAY), $gt: new Date(now - REMIND_WITHIN_DAYS * DAY) },
    })
    .limit(50)
    .toArray();
  let sent = 0;
  for (const order of due) {
    const claimed = await orders.updateOne(
      { _id: order._id, reviewReminder: { $exists: false } },
      { $set: { reviewReminder: { at: now, sent: false } } },
    );
    if (!claimed.modifiedCount) continue; // another sweep has it
    const user = await db.collection('users').findOne({ _id: order.userId });
    if (!user || user.reviewReminderEmails === false) continue;
    const products = await toReview(db, order, user);
    if (!products.length) continue;
    try {
      const email = reviewReminderEmail(user, order, products, ctx.config.mail?.publicUrl);
      await ctx.mail.send({ to: { email: user.email, name: user.name }, ...email });
      await orders.updateOne({ _id: order._id }, { $set: { 'reviewReminder.sent': true } });
      sent++;
    } catch (err) {
      console.error(`Could not send a review reminder for order ${order._id}:`, err.message);
      await orders.updateOne({ _id: order._id, 'reviewReminder.at': now }, { $unset: { reviewReminder: '' } });
    }
  }
  return sent;
}

// The order's products still worth asking about, in the order's order, each once (two sizes are one product).
async function toReview(db, order, user) {
  const returned = new Map();
  const returns = await db
    .collection('returns')
    .find({ orderId: order._id, status: { $ne: 'declined' } })
    .toArray();
  for (const r of returns) for (const i of r.items) returned.set(i.index, (returned.get(i.index) ?? 0) + i.qty);
  const ids = [];
  order.items.forEach((item, index) => {
    if (item.qty > (returned.get(index) ?? 0) && !ids.some((id) => id.equals(item.productId))) ids.push(item.productId);
  });
  if (!ids.length) return [];
  const [products, reviewed] = await Promise.all([
    db
      .collection('products')
      .find({ _id: { $in: ids }, active: true }, { projection: { title: 1, slug: 1 } })
      .toArray(),
    db.collection('reviews').distinct('productId', { userId: user._id, productId: { $in: ids } }),
  ]);
  return ids
    .filter((id) => !reviewed.some((r) => r.equals(id)))
    .map((id) => products.find((p) => p._id.equals(id)))
    .filter(Boolean)
    .slice(0, MAX_PRODUCTS);
}
