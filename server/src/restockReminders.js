import { z } from 'zod';
import { restockReminderEmail } from './emails.js';

// Restock reminders (stage 129): an everyday product (coffee, shampoo) can have `restockDays`, set by the
// admin. A customer whose delivered order had it gets one email about RESTOCK_DAYS after delivery, listing what is
// likely running out, with a link to buy it again. Collection `restockReminders` { orderId, productId, userId, at,
// sent } (unique per order and product) is the claim, so simultaneous sweeps send once and nothing is asked about
// twice; a failed email deletes its claims for the next sweep.
const DAY = 86_400_000;
export const MIN_RESTOCK_DAYS = 7;
export const MAX_RESTOCK_DAYS = 365;
// Deliveries more than this many days past their reminder day are never asked about (including those from before an
// admin set the days on a product), so switching it on doesn't email everyone who ever bought it.
export const LATE_DAYS = 14;
const PER_SWEEP = 100;

export const restockDaysField = z
  .number()
  .int()
  .min(MIN_RESTOCK_DAYS, `Remind after at least ${MIN_RESTOCK_DAYS} days`)
  .max(MAX_RESTOCK_DAYS, `Remind after at most ${MAX_RESTOCK_DAYS} days`)
  .nullable();

// Run every minute by index.js (and directly by tests, with `now`). Returns the number of emails sent.
export async function sendRestockReminders(ctx, now = new Date()) {
  const { db } = ctx;
  const orders = db.collection('orders');
  const claims = db.collection('restockReminders');
  const products = await db
    .collection('products')
    .find(
      { restockDays: { $type: 'number' }, active: true },
      { projection: { title: 1, slug: 1, stock: 1, restockDays: 1 } },
    )
    .toArray();

  // Due (order, product) pairs, grouped by customer so each gets one email.
  const byUser = new Map();
  for (const p of products) {
    const due = await orders
      .find(
        {
          status: 'delivered',
          'items.productId': p._id,
          deliveredAt: {
            $lte: new Date(now - p.restockDays * DAY),
            $gt: new Date(now - (p.restockDays + LATE_DAYS) * DAY),
          },
        },
        { projection: { userId: 1, createdAt: 1 } },
      )
      .limit(PER_SWEEP)
      .toArray();
    const asked = new Set(
      (
        await claims
          .find({ productId: p._id, orderId: { $in: due.map((o) => o._id) } }, { projection: { orderId: 1 } })
          .toArray()
      ).map((c) => c.orderId.toString()),
    );
    for (const order of due) {
      if (asked.has(order._id.toString())) continue;
      const key = order.userId.toString();
      if (!byUser.has(key)) byUser.set(key, []);
      byUser.get(key).push({ order, product: p });
    }
  }

  let sent = 0;
  for (const [, items] of byUser) {
    const userId = items[0].order.userId;
    // Claim each pair first; a pair another sweep claimed is skipped.
    const mine = [];
    for (const item of items) {
      try {
        await claims.insertOne({ orderId: item.order._id, productId: item.product._id, userId, at: now, sent: false });
        mine.push(item);
      } catch (err) {
        if (err.code !== 11000) throw err;
      }
    }
    if (!mine.length) continue;
    const user = await db.collection('users').findOne({ _id: userId });
    if (!user || user.restockReminderEmails === false) continue;
    const wanted = [];
    for (const { order, product } of mine) {
      if (product.stock <= 0) continue; // nothing to sell them now
      if (wanted.some((p) => p._id.equals(product._id))) continue;
      // Already bought again since, or sent back: no need to remind.
      const [again, returned] = await Promise.all([
        orders.findOne(
          { userId, 'items.productId': product._id, createdAt: { $gt: order.createdAt }, status: { $ne: 'cancelled' } },
          { projection: { _id: 1 } },
        ),
        db
          .collection('returns')
          .findOne(
            { orderId: order._id, 'items.productId': product._id, status: { $ne: 'declined' } },
            { projection: { _id: 1 } },
          ),
      ]);
      if (!again && !returned) wanted.push(product);
    }
    if (!wanted.length) continue;
    const claimed = { userId, at: now };
    try {
      const email = restockReminderEmail(user, wanted, ctx.config.mail?.publicUrl);
      await ctx.mail.send({ to: { email: user.email, name: user.name }, ...email });
      await claims.updateMany(claimed, { $set: { sent: true } });
      sent++;
    } catch (err) {
      console.error(`Could not send a restock reminder to user ${userId}:`, err.message);
      await claims.deleteMany(claimed);
    }
  }
  return sent;
}
