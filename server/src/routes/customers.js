import express from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { escapeRegex, HttpError, parse, parseObjectId } from '../http.js';
import { toAddress } from '../addressBook.js';
import { grantBody, grantCredit, toCreditEntry } from '../credit.js';
import { REFUNDED_RETURNS, SOLD } from './dashboard.js';
import { toRequest } from './help.js';
import { toReturn } from './returns.js';
import { codAllowed, refusedCodOrders } from '../cod.js';

// Admin → Customers (stage 74, admins only): every account with what it has bought, and one customer's whole story on
// one page (orders, returns, help requests, store credit), where an admin can also give store credit. Nothing is
// stored here: it all comes from the other collections. "Spent" is the dashboard's revenue for that customer: sold
// orders' totals (placed, shipped, delivered) less refunds of approved returns.

export const PAGE = 25;
const SORTS = {
  recent: { createdAt: -1, _id: -1 },
  spent: { spent: -1, _id: -1 },
  last_order: { lastOrderAt: -1, _id: -1 },
};
const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  sort: z.enum(Object.keys(SORTS)).default('recent'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

// Per account: sold orders (count, money, latest) and refunded returns, as fields on the user.
const salesStages = [
  {
    $lookup: {
      from: 'orders',
      let: { id: '$_id' },
      pipeline: [
        { $match: { $expr: { $eq: ['$userId', '$$id'] }, status: { $in: SOLD } } },
        { $group: { _id: null, orders: { $sum: 1 }, total: { $sum: '$total' }, last: { $max: '$createdAt' } } },
      ],
      as: 'sales',
    },
  },
  {
    $lookup: {
      from: 'returns',
      let: { id: '$_id' },
      pipeline: [
        { $match: { $expr: { $eq: ['$userId', '$$id'] }, status: { $in: REFUNDED_RETURNS } } },
        { $group: { _id: null, refunded: { $sum: '$refund' }, returns: { $sum: 1 } } },
      ],
      as: 'refunds',
    },
  },
  {
    $set: {
      orders: { $ifNull: [{ $first: '$sales.orders' }, 0] },
      refunded: { $ifNull: [{ $first: '$refunds.refunded' }, 0] },
      returns: { $ifNull: [{ $first: '$refunds.returns' }, 0] },
      spent: {
        $subtract: [{ $ifNull: [{ $first: '$sales.total' }, 0] }, { $ifNull: [{ $first: '$refunds.refunded' }, 0] }],
      },
      lastOrderAt: { $ifNull: [{ $first: '$sales.last' }, null] },
    },
  },
];

const toRow = (u) => ({
  id: u._id.toString(),
  name: u.name,
  email: u.email,
  role: u.role,
  createdAt: u.createdAt,
  orders: u.orders,
  spent: u.spent,
  lastOrderAt: u.lastOrderAt,
  credit: u.credit ?? 0,
});

const toOrderRow = (o) => ({
  id: o._id.toString(),
  number: o.number ?? null,
  status: o.status,
  total: o.total,
  creditUsed: o.creditUsed ?? 0,
  items: o.items.reduce((n, i) => n + i.qty, 0),
  createdAt: o.createdAt,
});

export function customersRouter(ctx) {
  const { db } = ctx;
  const users = db.collection('users');
  const router = express.Router();
  router.use('/admin/customers', requireAdmin);

  // Accounts, by name or email; newest, biggest spenders or latest order first.
  router.get('/admin/customers', async (req, res) => {
    const query = parse(listQuery, req.query);
    const match = {};
    if (query.q) {
      const pattern = { $regex: escapeRegex(query.q), $options: 'i' };
      match.$or = [{ name: pattern }, { email: pattern }];
    }
    const [result] = await users
      .aggregate([
        { $match: match },
        ...salesStages,
        { $sort: SORTS[query.sort] },
        {
          $facet: {
            items: [{ $skip: (query.page - 1) * PAGE }, { $limit: PAGE }],
            total: [{ $count: 'n' }],
          },
        },
      ])
      .toArray();
    res.json({
      items: result.items.map(toRow),
      total: result.total[0]?.n ?? 0,
      page: query.page,
      pageSize: PAGE,
    });
  });

  router.get('/admin/customers/:id', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'customer id');
    const [user] = await users.aggregate([{ $match: { _id } }, ...salesStages]).toArray();
    if (!user) throw new HttpError(404, 'Customer not found');
    const mine = { userId: _id };
    const [orders, returns, help, credit, reviews, questions, wishlist] = await Promise.all([
      db.collection('orders').find(mine).sort({ createdAt: -1 }).limit(20).toArray(),
      db.collection('returns').find(mine).sort({ createdAt: -1 }).limit(10).toArray(),
      db.collection('helpRequests').find(mine).sort({ updatedAt: -1 }).limit(10).toArray(),
      db.collection('creditLedger').find(mine).sort({ at: -1, _id: -1 }).limit(20).toArray(),
      db.collection('reviews').countDocuments(mine),
      db.collection('questions').countDocuments(mine),
      db.collection('wishlist').countDocuments(mine),
    ]);
    res.json({
      customer: {
        ...toRow(user),
        twoStep: Boolean(user.totp?.enabledAt),
        addresses: (user.addresses ?? []).map(toAddress),
        emails: { priceDrops: user.priceDropEmails !== false, cartReminders: user.cartReminderEmails !== false },
      },
      totals: {
        orders: user.orders,
        spent: user.spent,
        refunded: user.refunded,
        returns: user.returns,
        reviews,
        questions,
        wishlist,
        allOrders: await db.collection('orders').countDocuments(mine),
      },
      orders: orders.map(toOrderRow),
      returns: returns.map(toReturn),
      help: help.map((h) => {
        const { id, number, topic, status, updatedAt, messages } = toRequest(h);
        return { id, number, topic, status, updatedAt, messages: messages.length };
      }),
      credit: credit.map(toCreditEntry),
      // Cash on Delivery: COD orders that came back for a reason that was theirs, and whether they may still use it.
      cod: { refused: await refusedCodOrders(db, user), allowed: (await codAllowed(db, user)).allowed },
    });
  });

  // Their balance, for the credit form (shared with help requests, which have the same pair of routes).
  router.get('/admin/customers/:id/credit', async (req, res) => {
    const customer = await users.findOne(
      { _id: parseObjectId(req.params.id, 'customer id') },
      { projection: { credit: 1 } },
    );
    if (!customer) throw new HttpError(404, 'Customer not found');
    res.json({ balance: customer.credit ?? 0 });
  });

  // Goodwill store credit from the customer's page (the same as from a help request).
  router.post('/admin/customers/:id/credit', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'customer id');
    const { amount, note } = parse(grantBody, req.body);
    const customer = await users.findOne({ _id });
    if (!customer) throw new HttpError(404, 'Customer not found');
    const balance = await grantCredit(ctx, req.user, customer, { amount, note, label: customer.name });
    res.json({ balance });
  });

  return router;
}
