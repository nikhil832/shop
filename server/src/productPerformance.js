import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { clientIp, hashToken, networkOf, requireAdmin } from './auth.js';
import { HttpError, parse } from './http.js';
import { takeHourlySlot } from './rateLimit.js';
import { isStaff } from './staff.js';

// Product performance (stage 100): how often each product is looked at and added to the cart, next to how often it
// is bought, so an admin can see what is looked at but not bought. The product page reports a view once per page load
// and a click on "Add to cart" (POST /products/:slug/seen with `event`), counted per product per India-time day in
// `productStats` { productId, day ('YYYY-MM-DD'), views, carts, expiresAt } (unique pair, TTL KEEP_DAYS). Nothing
// about the visitor is stored; staff are not counted; each network may report EVENTS_PER_HOUR an hour (hashed, in
// rateLimits like other public limits). Orders come from sold orders, like the dashboard's best sellers.
export const KEEP_DAYS = 100;
export const EVENTS_PER_HOUR = 300;
// Looked at this many times in the period without an order: "looked at, not bought".
export const NOT_BOUGHT_VIEWS = 10;
const PERIODS = [7, 30, 90];
// Kept here rather than imported from dashboard.js, like the other modules that need it.
const SOLD = ['placed', 'shipped', 'delivered'];
const DAY = 86_400_000;
const IST_OFFSET = 330 * 60_000;
const istDay = (date) => new Date(date.getTime() + IST_OFFSET).toISOString().slice(0, 10);
// Midnight India time at the start of the day `n` days before today's.
const dayStart = (now, n) => new Date(Date.parse(istDay(new Date(now - n * DAY))) - IST_OFFSET);

const seenBody = z.object({ event: z.enum(['view', 'cart']) });
const listQuery = z.object({
  days: z.coerce
    .number()
    .refine((d) => PERIODS.includes(d), 'Choose 7, 30 or 90 days')
    .default(30),
  sort: z.enum(['views', 'carts', 'orders', 'conversion']).default('views'),
  notBought: z.literal('1').optional(),
});

// Views → orders as a percentage with one decimal, or null without views.
const conversion = (views, orders) => (views ? Math.round((orders / views) * 1000) / 10 : null);

export function productPerformanceRouter({ db, config }) {
  const stats = db.collection('productStats');
  const router = express.Router();

  router.post('/products/:slug/seen', async (req, res) => {
    const { event } = parse(seenBody, req.body);
    if (req.user && isStaff(req.user)) return res.status(204).end();
    const product = await db
      .collection('products')
      .findOne({ slug: req.params.slug, active: true }, { projection: { _id: 1 } });
    if (!product) throw new HttpError(404, 'Product not found');
    const network = networkOf(clientIp(req, config));
    if (!(await takeHourlySlot(db, `productSeen:${hashToken(network)}`, EVENTS_PER_HOUR))) {
      return res.status(204).end(); // quietly not counted
    }
    const now = new Date();
    const day = istDay(now);
    await stats.updateOne(
      { productId: product._id, day },
      {
        $inc: { [event === 'view' ? 'views' : 'carts']: 1 },
        $setOnInsert: { expiresAt: new Date(Date.parse(day) - IST_OFFSET + KEEP_DAYS * DAY) },
      },
      { upsert: true },
    );
    res.status(204).end();
  });

  // Per product over the last `days` days (today included): views, adds to cart, orders and units sold.
  router.get('/admin/product-performance', requireAdmin, async (req, res) => {
    const { days, sort, notBought } = parse(listQuery, req.query);
    const now = new Date();
    const from = dayStart(now, days - 1);
    const [seen, sold] = await Promise.all([
      stats
        .aggregate([
          { $match: { day: { $gte: istDay(from) } } },
          { $group: { _id: '$productId', views: { $sum: '$views' }, carts: { $sum: '$carts' } } },
        ])
        .toArray(),
      db
        .collection('orders')
        .aggregate([
          { $match: { status: { $in: SOLD }, createdAt: { $gte: from } } },
          { $unwind: '$items' },
          {
            $group: {
              _id: '$items.productId',
              orders: { $addToSet: '$_id' },
              units: { $sum: '$items.qty' },
            },
          },
          { $project: { orders: { $size: '$orders' }, units: 1 } },
        ])
        .toArray(),
    ]);
    const rows = new Map();
    const row = (id) => {
      const key = id.toString();
      if (!rows.has(key)) rows.set(key, { productId: key, views: 0, carts: 0, orders: 0, units: 0 });
      return rows.get(key);
    };
    for (const s of seen) Object.assign(row(s._id), { views: s.views, carts: s.carts });
    for (const s of sold) Object.assign(row(s._id), { orders: s.orders, units: s.units });
    const products = await db
      .collection('products')
      .find(
        { _id: { $in: [...rows.keys()].map((id) => new ObjectId(id)) } },
        { projection: { title: 1, slug: 1, active: 1 } },
      )
      .toArray();
    const byId = new Map(products.map((p) => [p._id.toString(), p]));
    let items = [...rows.values()]
      .filter((r) => byId.has(r.productId))
      .map((r) => {
        const p = byId.get(r.productId);
        return {
          ...r,
          title: p.title,
          slug: p.slug,
          active: p.active !== false,
          conversion: conversion(r.views, r.orders),
          notBought: r.views >= NOT_BOUGHT_VIEWS && r.orders === 0,
        };
      });
    if (notBought) items = items.filter((r) => r.notBought);
    const key = (r) => (sort === 'conversion' ? (r.conversion ?? -1) : r[sort]);
    items.sort((a, b) => key(b) - key(a) || b.views - a.views || a.title.localeCompare(b.title));
    res.json({
      days,
      from: istDay(from),
      items: items.slice(0, 200),
      total: items.length,
      notBoughtViews: NOT_BOUGHT_VIEWS,
    });
  });

  return router;
}
