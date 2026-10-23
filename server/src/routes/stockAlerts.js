import express from 'express';
import { requireUser } from '../auth.js';
import { backInStockEmail } from '../emails.js';
import { HttpError, parseObjectId } from '../http.js';
import { findVariant } from '../variants.js';

export const STOCK_ALERT_LIMIT = 50;
// A claim older than this is from a send that never finished (e.g. the server restarted), so it is tried again.
const CLAIM_MS = 10 * 60_000;

// "Email me when it's back": one `stockAlerts` document per (user, out-of-stock product), or per (user, product,
// sold-out variant) with `variantId` (`?variant=<id>`), for logged-in customers only (the email goes to their account,
// so nobody can sign up someone else's address). A product-level alert waits for the whole product to be back.
export function stockAlertsRouter({ db }) {
  const alerts = db.collection('stockAlerts');
  const products = db.collection('products');
  const router = express.Router();
  router.use('/stock-alerts', requireUser);

  // The alert's key: the product, and the variant when `?variant=` is given (null otherwise, as the index stores it).
  function alertKey(req) {
    const productId = parseObjectId(req.params.productId, 'product id');
    const variantId = req.query.variant ? parseObjectId(String(req.query.variant), 'variant id') : null;
    return { userId: req.user._id, productId, variantId };
  }

  router.put('/stock-alerts/:productId', async (req, res) => {
    const key = alertKey(req);
    const product = await products.findOne(
      { _id: key.productId, active: true },
      { projection: { stock: 1, variants: 1, variantName: 1 } },
    );
    if (!product) throw new HttpError(404, 'Product not found');
    if (key.variantId) {
      const variant = findVariant(product, key.variantId);
      if (!variant) throw new HttpError(404, 'Variant not found');
      if (variant.stock > 0)
        throw new HttpError(409, `This ${product.variantName.toLowerCase()} is in stock: you can buy it now`);
    } else if (product.stock > 0) {
      throw new HttpError(409, 'This product is in stock: you can buy it now');
    }
    if ((await alerts.countDocuments({ userId: key.userId })) >= STOCK_ALERT_LIMIT) {
      if (!(await alerts.findOne(key))) {
        throw new HttpError(409, `You can have ${STOCK_ALERT_LIMIT} stock alerts at a time. Cancel one first`);
      }
    }
    await alerts.updateOne(key, { $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    res.json({ stockAlert: true });
  });

  router.delete('/stock-alerts/:productId', async (req, res) => {
    await alerts.deleteOne(alertKey(req));
    res.json({ stockAlert: false });
  });

  return router;
}

// Run every minute by index.js (and directly by tests). Emails everyone waiting for a product that is back in stock
// and shown in the store, once: each alert is claimed, sent, then deleted. A failed send is retried next minute.
// Catches every way stock comes back (admin edits, cancelled or expired orders). Returns the number sent.
export async function sendBackInStockAlerts(ctx) {
  const { db } = ctx;
  const alerts = db.collection('stockAlerts');
  const due = await alerts
    .aggregate([
      { $match: { $or: [{ sentAt: { $exists: false } }, { sentAt: { $lt: new Date(Date.now() - CLAIM_MS) } }] } },
      { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'product' } },
      { $unwind: '$product' },
      // The variant asked about, if any (null when it has been deleted since).
      {
        $addFields: {
          variant: {
            $first: {
              $filter: { input: { $ifNull: ['$product.variants', []] }, cond: { $eq: ['$$this._id', '$variantId'] } },
            },
          },
        },
      },
      {
        $match: {
          'product.active': true,
          $or: [
            { variantId: null, 'product.stock': { $gt: 0 } },
            { variantId: { $ne: null }, 'variant.stock': { $gt: 0 } },
            // A variant deleted since: the alert is dropped below, without an email.
            { variantId: { $ne: null }, variant: null },
          ],
        },
      },
      { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      { $limit: 100 },
    ])
    .toArray();
  let sent = 0;
  for (const alert of due) {
    const claimed = await alerts.updateOne(
      { _id: alert._id, sentAt: alert.sentAt ?? { $exists: false } },
      { $set: { sentAt: new Date() } },
    );
    if (!claimed.modifiedCount) continue; // another sweep has it
    if (alert.variantId && !alert.variant) {
      await alerts.deleteOne({ _id: alert._id });
      continue;
    }
    try {
      const { user, product, variant } = alert;
      const email = backInStockEmail(user, product, ctx.config.mail?.publicUrl, variant);
      await ctx.mail.send({ to: { email: user.email, name: user.name }, ...email });
      await alerts.deleteOne({ _id: alert._id });
      sent++;
    } catch (err) {
      console.error(`Could not send a back-in-stock email for alert ${alert._id}:`, err.message);
      await alerts.updateOne({ _id: alert._id }, { $unset: { sentAt: '' } });
    }
  }
  return sent;
}
