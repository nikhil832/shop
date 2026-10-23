import express from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { parse } from '../http.js';
import { LOW_STOCK } from './admin.js';

const dashboardQuery = z.object({
  days: z.enum(['7', '30', '90'], 'Choose 7, 30 or 90 days').default('30').transform(Number),
});

// Orders that count as sales: paid for or to be paid on delivery. Unpaid online orders and cancelled ones don't.
const SOLD = ['placed', 'shipped', 'delivered'];
// Days are counted in India time (no daylight saving, so a fixed offset is exact).
const TIME_ZONE = 'Asia/Kolkata';
const IST_OFFSET = 330 * 60_000;
const DAY = 86_400_000;
const BEST_SELLERS = 5;
const LOW_STOCK_LIST = 10;

// The first moment of the period: midnight India time, `days - 1` days before today.
function periodStart(now, days) {
  const today = Math.floor((now.getTime() + IST_OFFSET) / DAY) * DAY - IST_OFFSET;
  return new Date(today - (days - 1) * DAY);
}
const isoDay = (time) => new Date(time + IST_OFFSET).toISOString().slice(0, 10);

const totalsGroup = {
  _id: null,
  revenue: { $sum: '$total' },
  orders: { $sum: 1 },
  discount: { $sum: { $ifNull: ['$discount', 0] } },
  itemsSold: { $sum: { $sum: '$items.qty' } },
};

export function dashboardRouter({ db }) {
  const orders = db.collection('orders');
  const products = db.collection('products');
  const router = express.Router();
  router.use('/admin/dashboard', requireAdmin);

  // Sales for the last 7, 30 or 90 days (today included) and the same length before, revenue per day, best sellers,
  // and what needs attention now: orders to ship and products running out.
  router.get('/admin/dashboard', async (req, res) => {
    const { days } = parse(dashboardQuery, req.query);
    const from = periodStart(new Date(), days);
    const previousFrom = new Date(from.getTime() - days * DAY);
    const current = { createdAt: { $gte: from }, status: { $in: SOLD } };

    const [[stats], toShip, lowStock, lowStockCount] = await Promise.all([
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
                { $sort: { qty: -1, sales: -1, _id: 1 } },
                { $limit: BEST_SELLERS },
              ],
            },
          },
        ])
        .toArray(),
      orders.countDocuments({ status: 'placed' }),
      products
        .find({ active: true, stock: { $lte: LOW_STOCK } }, { projection: { slug: 1, title: 1, stock: 1 } })
        .sort({ stock: 1, title: 1 })
        .limit(LOW_STOCK_LIST)
        .toArray(),
      products.countDocuments({ active: true, stock: { $lte: LOW_STOCK } }),
    ]);

    const totals = stats.current[0] ?? { revenue: 0, orders: 0, discount: 0, itemsSold: 0 };
    const previous = stats.previous[0] ?? { revenue: 0, orders: 0 };
    const byDay = new Map(stats.daily.map((d) => [d._id, d]));
    // Every day of the period, with zeros for days without sales.
    const daily = Array.from({ length: days }, (_, i) => {
      const date = isoDay(from.getTime() + i * DAY);
      return { date, revenue: byDay.get(date)?.revenue ?? 0, orders: byDay.get(date)?.orders ?? 0 };
    });
    // Slugs (for links) from the products as they are now; titles from the orders, as sold.
    const slugs = new Map(
      (
        await products
          .find({ _id: { $in: stats.bestSellers.map((b) => b._id) } }, { projection: { slug: 1 } })
          .toArray()
      ).map((p) => [p._id.toString(), p.slug]),
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
      },
      previous: { revenue: previous.revenue, orders: previous.orders },
      daily,
      bestSellers: stats.bestSellers.map((b) => ({
        productId: b._id.toString(),
        slug: slugs.get(b._id.toString()) ?? null,
        title: b.title,
        qty: b.qty,
        sales: b.sales,
      })),
      toShip,
      lowStock: lowStock.map((p) => ({ id: p._id.toString(), slug: p.slug, title: p.title, stock: p.stock })),
      lowStockCount,
    });
  });

  return router;
}
