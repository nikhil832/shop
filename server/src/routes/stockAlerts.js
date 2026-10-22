import express from 'express';
import { requireUser } from '../auth.js';
import { backInStockEmail } from '../emails.js';
import { HttpError, parseObjectId } from '../http.js';

export const STOCK_ALERT_LIMIT = 50;
// A claim older than this is from a send that never finished (e.g. the server restarted), so it is tried again.
const CLAIM_MS = 10 * 60_000;

// "Email me when it's back": one `stockAlerts` document per (user, out-of-stock product), for logged-in customers
// only (the email goes to their account, so nobody can sign up someone else's address).
export function stockAlertsRouter({ db }) {
  const alerts = db.collection('stockAlerts');
  const products = db.collection('products');
  const router = express.Router();
  router.use('/stock-alerts', requireUser);

  router.put('/stock-alerts/:productId', async (req, res) => {
    const productId = parseObjectId(req.params.productId, 'product id');
    const product = await products.findOne({ _id: productId, active: true }, { projection: { stock: 1 } });
    if (!product) throw new HttpError(404, 'Product not found');
    if (product.stock > 0) throw new HttpError(409, 'This product is in stock: you can buy it now');
    const userId = req.user._id;
    if ((await alerts.countDocuments({ userId })) >= STOCK_ALERT_LIMIT) {
      if (!(await alerts.findOne({ userId, productId }))) {
        throw new HttpError(409, `You can have ${STOCK_ALERT_LIMIT} stock alerts at a time. Cancel one first`);
      }
    }
    await alerts.updateOne({ userId, productId }, { $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    res.json({ stockAlert: true });
  });

  router.delete('/stock-alerts/:productId', async (req, res) => {
    const productId = parseObjectId(req.params.productId, 'product id');
    await alerts.deleteOne({ userId: req.user._id, productId });
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
      { $match: { 'product.active': true, 'product.stock': { $gt: 0 } } },
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
    try {
      const { user, product } = alert;
      const email = backInStockEmail(user, product, ctx.config.mail?.publicUrl);
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
