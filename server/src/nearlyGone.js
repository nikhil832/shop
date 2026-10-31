import { nearlyGoneEmail } from './emails.js';

// "Nearly gone" emails (stage 132): a customer with a product on their wishlist gets one email when it's down to its
// last few (1 to NEARLY_GONE_AT left in all), so they don't miss it. Each wishlist entry is claimed by setting
// `nearlyGoneAt` (missing or older than AGAIN_DAYS in the filter), so simultaneous sweeps send once and a product that
// sells low, is restocked and runs low again can be mentioned again a month later. Hidden products wait; customers
// with `nearlyGoneEmails: false` (the account page) get none. One email per customer per sweep; a failed email puts
// the claims back for the next sweep.
export const NEARLY_GONE_AT = 3;
export const AGAIN_DAYS = 30;
const DAY = 86_400_000;

// Run every minute by index.js (and directly by tests, with `now`). Returns the number of emails sent.
export async function sendNearlyGoneEmails(ctx, now = new Date()) {
  const { db } = ctx;
  const wishlist = db.collection('wishlist');
  const fresh = {
    $or: [{ nearlyGoneAt: { $exists: false } }, { nearlyGoneAt: { $lt: new Date(now - AGAIN_DAYS * DAY) } }],
  };
  const due = await wishlist
    .aggregate([
      { $match: fresh },
      { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'product' } },
      { $unwind: '$product' },
      { $match: { 'product.active': true, 'product.stock': { $gte: 1, $lte: NEARLY_GONE_AT } } },
      { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      { $match: { 'user.nearlyGoneEmails': { $ne: false } } },
      { $sort: { userId: 1, addedAt: -1 } },
      { $limit: 1000 },
    ])
    .toArray();

  const byUser = new Map();
  for (const w of due) {
    const key = w.userId.toString();
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push(w);
  }
  let sent = 0;
  for (const items of byUser.values()) {
    const claimed = [];
    for (const w of items) {
      const { modifiedCount } = await wishlist.updateOne({ _id: w._id, ...fresh }, { $set: { nearlyGoneAt: now } });
      if (modifiedCount) claimed.push(w); // otherwise another sweep has it
    }
    if (!claimed.length) continue;
    const { user } = claimed[0];
    try {
      const email = nearlyGoneEmail(
        user,
        claimed.map((w) => w.product),
        ctx.config.mail?.publicUrl,
      );
      await ctx.mail.send({ to: { email: user.email, name: user.name }, ...email });
      sent++;
    } catch (err) {
      console.error(`Could not send a nearly-gone email to user ${user._id}:`, err.message);
      await wishlist.bulkWrite(
        claimed.map((w) => ({
          updateOne: {
            filter: { _id: w._id, nearlyGoneAt: now },
            update: w.nearlyGoneAt ? { $set: { nearlyGoneAt: w.nearlyGoneAt } } : { $unset: { nearlyGoneAt: '' } },
          },
        })),
      );
    }
  }
  return sent;
}
