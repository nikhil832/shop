import express from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { parse } from '../http.js';
import { LOW_STOCK } from './admin.js';
import { logActivity } from '../activity.js';
import { UNANSWERED } from './questions.js';
import { storageUse } from '../storage.js';

// The `settings` document of the morning low-stock email (lowStockEmail.js): { day, at, enabled }.
export const LOW_STOCK_EMAIL = 'lowStockEmail';
const lowStockEmailBody = z.object({ enabled: z.boolean('Say whether to send it: true or false') });

const dashboardQuery = z.object({
  days: z.enum(['7', '30', '90'], 'Choose 7, 30 or 90 days').default('30').transform(Number),
});

// Orders that count as sales: paid for or to be paid on delivery. Unpaid online orders and cancelled ones don't.
export const SOLD = ['placed', 'shipped', 'delivered'];
// Returns that take money back: approved ones and later (requested and declined ones don't). They count against the
// period of the order they came from, so "these 30 days" means what was sold then and kept.
export const REFUNDED_RETURNS = ['approved', 'refunding', 'refunded', 'refund_failed'];
// Days are counted in India time (no daylight saving, so a fixed offset is exact).
const TIME_ZONE = 'Asia/Kolkata';
const IST_OFFSET = 330 * 60_000;
const DAY = 86_400_000;
const BEST_SELLERS = 5;
const LOW_STOCK_LIST = 10;
// Low: the product, or one of its variants, has LOW_STOCK or fewer left.
export const LOW = { $or: [{ stock: { $lte: LOW_STOCK } }, { 'variants.stock': { $lte: LOW_STOCK } }] };

// Products in the store running out, lowest first (a product with variants is as low as its lowest variant), at most
// `limit`, each with the variants that are low themselves, e.g. [{ label: 'UK 10', stock: 2 }]. Also used by the daily
// low-stock email.
export async function lowStockProducts(db, limit) {
  const docs = await db
    .collection('products')
    .aggregate([
      { $match: { active: true, ...LOW } },
      { $addFields: { lowest: { $min: ['$stock', { $min: '$variants.stock' }] } } },
      { $sort: { lowest: 1, title: 1 } },
      { $limit: limit },
      { $project: { slug: 1, title: 1, stock: 1, variants: 1 } },
    ])
    .toArray();
  return docs.map((p) => ({
    id: p._id.toString(),
    slug: p.slug,
    title: p.title,
    stock: p.stock,
    variants: (p.variants ?? []).filter((v) => v.stock <= LOW_STOCK).map((v) => ({ label: v.label, stock: v.stock })),
  }));
}

// The first moment of the period: midnight India time, `days - 1` days before today.
function periodStart(now, days) {
  const today = Math.floor((now.getTime() + IST_OFFSET) / DAY) * DAY - IST_OFFSET;
  return new Date(today - (days - 1) * DAY);
}
export const isoDay = (time) => new Date(time + IST_OFFSET).toISOString().slice(0, 10);

const totalsGroup = {
  _id: null,
  revenue: { $sum: '$total' },
  orders: { $sum: 1 },
  discount: { $sum: { $ifNull: ['$discount', 0] } },
  itemsSold: { $sum: { $sum: '$items.qty' } },
};

export function dashboardRouter({ db, config }) {
  const orders = db.collection('orders');
  const returns = db.collection('returns');
  const products = db.collection('products');
  const router = express.Router();
  router.use('/admin/dashboard', requireAdmin);

  // Sales for the last 7, 30 or 90 days (today included) and the same length before, revenue per day, refunds from
  // returns (REFUNDED_RETURNS) and the net, best sellers, and what needs attention now: orders to ship and products
  // running out.
  router.get('/admin/dashboard', async (req, res) => {
    const { days } = parse(dashboardQuery, req.query);
    const from = periodStart(new Date(), days);
    const previousFrom = new Date(from.getTime() - days * DAY);
    const current = { createdAt: { $gte: from }, status: { $in: SOLD } };

    const [[stats], [refundStats], toShip, lowStock, lowStockCount, emailSettings, questionsToAnswer, storage] =
      await Promise.all([
        orders
          .aggregate([
            { $match: { createdAt: { $gte: previousFrom } } },
            {
              $facet: {
                current: [{ $match: current }, { $group: totalsGroup }],
                previous: [
                  { $match: { createdAt: { $lt: from }, status: { $in: SOLD } } },
                  { $group: { _id: null, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
                ],
                cancelled: [{ $match: { createdAt: { $gte: from }, status: 'cancelled' } }, { $count: 'n' }],
                daily: [
                  { $match: current },
                  {
                    $group: {
                      _id: { $dateToString: { date: '$createdAt', format: '%Y-%m-%d', timezone: TIME_ZONE } },
                      revenue: { $sum: '$total' },
                      orders: { $sum: 1 },
                    },
                  },
                ],
                bestSellers: [
                  { $match: current },
                  { $unwind: '$items' },
                  {
                    $group: {
                      _id: '$items.productId',
                      title: { $last: '$items.title' },
                      qty: { $sum: '$items.qty' },
                      sales: { $sum: { $multiply: ['$items.price', '$items.qty'] } },
                    },
                  },
                ],
              },
            },
          ])
          .toArray(),
        // Refunds from returns of the orders in both periods, by the order's day, and the items they gave back.
        returns
          .aggregate([
            { $match: { status: { $in: REFUNDED_RETURNS } } },
            {
              $lookup: {
                from: 'orders',
                localField: 'orderId',
                foreignField: '_id',
                as: 'order',
                pipeline: [{ $project: { createdAt: 1, status: 1 } }],
              },
            },
            { $unwind: '$order' },
            { $match: { 'order.createdAt': { $gte: previousFrom }, 'order.status': { $in: SOLD } } },
            {
              $facet: {
                current: [
                  { $match: { 'order.createdAt': { $gte: from } } },
                  { $group: { _id: null, refunds: { $sum: '$refund' }, items: { $sum: { $sum: '$items.qty' } } } },
                ],
                previous: [
                  { $match: { 'order.createdAt': { $lt: from } } },
                  { $group: { _id: null, refunds: { $sum: '$refund' } } },
                ],
                daily: [
                  { $match: { 'order.createdAt': { $gte: from } } },
                  {
                    $group: {
                      _id: { $dateToString: { date: '$order.createdAt', format: '%Y-%m-%d', timezone: TIME_ZONE } },
                      refunds: { $sum: '$refund' },
                    },
                  },
                ],
                byProduct: [
                  { $match: { 'order.createdAt': { $gte: from } } },
                  { $unwind: '$items' },
                  {
                    $group: {
                      _id: '$items.productId',
                      qty: { $sum: '$items.qty' },
                      value: { $sum: { $multiply: ['$items.price', '$items.qty'] } },
                    },
                  },
                ],
              },
            },
          ])
          .toArray(),
        orders.countDocuments({ status: 'placed' }),
        lowStockProducts(db, LOW_STOCK_LIST),
        products.countDocuments({ active: true, ...LOW }),
        db.collection('settings').findOne({ _id: LOW_STOCK_EMAIL }),
        db.collection('questions').countDocuments(UNANSWERED),
        storageUse(db, config),
      ]);

    const totals = stats.current[0] ?? { revenue: 0, orders: 0, discount: 0, itemsSold: 0 };
    const previous = stats.previous[0] ?? { revenue: 0, orders: 0 };
    const refunded = refundStats.current[0] ?? { refunds: 0, items: 0 };
    const refundedBefore = refundStats.previous[0]?.refunds ?? 0;
    const byDay = new Map(stats.daily.map((d) => [d._id, d]));
    const refundsByDay = new Map(refundStats.daily.map((d) => [d._id, d.refunds]));
    const returnedBy = new Map(refundStats.byProduct.map((r) => [r._id.toString(), r]));
    // Best sellers by what was kept: items sold less items returned.
    const bestSellers = stats.bestSellers
      .map((b) => {
        const back = returnedBy.get(b._id.toString());
        return { ...b, returned: back?.qty ?? 0, qty: b.qty - (back?.qty ?? 0), sales: b.sales - (back?.value ?? 0) };
      })
      .filter((b) => b.qty > 0)
      .sort((a, b) => b.qty - a.qty || b.sales - a.sales || a._id.toString().localeCompare(b._id.toString()))
      .slice(0, BEST_SELLERS);
    // Every day of the period, with zeros for days without sales.
    const daily = Array.from({ length: days }, (_, i) => {
      const date = isoDay(from.getTime() + i * DAY);
      return {
        date,
        revenue: byDay.get(date)?.revenue ?? 0,
        orders: byDay.get(date)?.orders ?? 0,
        refunds: refundsByDay.get(date) ?? 0,
      };
    });
    // Slugs (for links) and titles from the products as they are now: order lines name the variant bought ("… (Size:
    // UK 8)"), while a best seller counts all of them. A product since deleted keeps the title from its orders.
    const liveProducts = new Map(
      (
        await products
          .find({ _id: { $in: bestSellers.map((b) => b._id) } }, { projection: { slug: 1, title: 1 } })
          .toArray()
      ).map((p) => [p._id.toString(), p]),
    );

    res.json({
      days,
      from,
      totals: {
        revenue: totals.revenue,
        orders: totals.orders,
        averageOrder: totals.orders ? Math.round(totals.revenue / totals.orders) : 0,
        itemsSold: totals.itemsSold,
        discount: totals.discount,
        cancelled: stats.cancelled[0]?.n ?? 0,
        // Refunds of returns from these orders, and what was kept.
        refunds: refunded.refunds,
        itemsReturned: refunded.items,
        netRevenue: totals.revenue - refunded.refunds,
      },
      previous: {
        revenue: previous.revenue,
        orders: previous.orders,
        refunds: refundedBefore,
        netRevenue: previous.revenue - refundedBefore,
      },
      daily,
      bestSellers: bestSellers.map((b) => ({
        productId: b._id.toString(),
        slug: liveProducts.get(b._id.toString())?.slug ?? null,
        title: liveProducts.get(b._id.toString())?.title ?? b.title,
        qty: b.qty,
        returned: b.returned,
        sales: b.sales,
      })),
      toShip,
      lowStock,
      lowStockCount,
      // Whether the admins get the low-stock list by email each morning (on unless switched off).
      lowStockEmail: emailSettings?.enabled !== false,
      // Customers' questions on products waiting for an answer.
      questionsToAnswer,
      // How full the database is (storage.js).
      storage,
    });
  });

  // Switches the morning low-stock email on or off for every admin.
  router.put('/admin/dashboard/low-stock-email', async (req, res) => {
    const { enabled } = parse(lowStockEmailBody, req.body);
    const before = await db
      .collection('settings')
      .findOneAndUpdate({ _id: LOW_STOCK_EMAIL }, { $set: { enabled } }, { upsert: true, returnDocument: 'before' });
    if ((before?.enabled !== false) !== enabled) {
      await logActivity(db, req.user, {
        area: 'settings',
        action: enabled ? 'Switched on the low-stock email' : 'Switched off the low-stock email',
      });
    }
    res.json({ enabled });
  });

  return router;
}
