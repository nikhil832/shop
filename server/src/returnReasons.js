import express from 'express';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { EXCHANGE_REASONS, RETURN_REASONS } from './emails.js';
import { parse } from './http.js';

// Return reasons by product (stage 125, admins only): for orders placed in the period, which products came back
// (returns and exchanges that weren't declined or called off), how often against the units sold, and why. Counted by
// the order's date, so a rate compares like with like; the latest orders may still be returned, which the page says.
// Kept here rather than imported from dashboard.js, like the other modules that need it.
const SOLD = ['placed', 'shipped', 'delivered'];
const MAX_ROWS = 50;
const NOTES = 10;
const DAY = 86_400_000;
const IST_OFFSET = 330 * 60_000;

// Reasons are kept per kind, as both lists have an "other": 'return:damaged', 'exchange:fit'…
const LABELS = {
  ...Object.fromEntries(Object.entries(RETURN_REASONS).map(([k, v]) => [`return:${k}`, v])),
  ...Object.fromEntries(Object.entries(EXCHANGE_REASONS).map(([k, v]) => [`exchange:${k}`, `${v} (exchange)`])),
};
LABELS['return:other'] = 'Other (return)';

const reportQuery = z.object({ days: z.enum(['30', '90', '365']).default('90') });

// India-time midnight `days − 1` days before today, so the period includes today.
function periodStart(now, days) {
  const today = new Date(Math.floor((now.getTime() + IST_OFFSET) / DAY) * DAY - IST_OFFSET);
  return new Date(today.getTime() - (days - 1) * DAY);
}

// Units per product and reason from `collection`'s requests (not in `skip` statuses) on orders made since `from`.
function cameBack(collection, skip, from) {
  return collection
    .aggregate([
      { $match: { status: { $nin: skip } } },
      {
        $lookup: {
          from: 'orders',
          localField: 'orderId',
          foreignField: '_id',
          as: 'order',
          pipeline: [{ $project: { createdAt: 1 } }],
        },
      },
      { $match: { 'order.createdAt': { $gte: from } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: { productId: '$items.productId', reason: '$reason' },
          units: { $sum: '$items.qty' },
          title: { $first: '$items.title' },
        },
      },
    ])
    .toArray();
}

// The latest notes customers left on those requests.
function latestNotes(collection, skip, from) {
  return collection
    .aggregate([
      { $match: { status: { $nin: skip }, note: { $type: 'string', $ne: '' } } },
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: 'orders',
          localField: 'orderId',
          foreignField: '_id',
          as: 'order',
          pipeline: [{ $project: { createdAt: 1 } }],
        },
      },
      { $match: { 'order.createdAt': { $gte: from } } },
      { $limit: NOTES },
      { $project: { orderId: 1, orderNumber: 1, items: 1, reason: 1, note: 1, createdAt: 1 } },
    ])
    .toArray();
}

export function returnReasonsRouter({ db }) {
  const router = express.Router();

  router.get('/admin/return-reasons', requireAdmin, async (req, res) => {
    const days = Number(parse(reportQuery, req.query).days);
    const from = periodStart(new Date(), days);
    const RETURN_SKIP = ['declined'];
    const EXCHANGE_SKIP = ['declined', 'cancelled'];
    const [sold, returned, exchanged, returnNotes, exchangeNotes] = await Promise.all([
      db
        .collection('orders')
        .aggregate([
          { $match: { createdAt: { $gte: from }, status: { $in: SOLD } } },
          { $unwind: '$items' },
          { $group: { _id: '$items.productId', units: { $sum: '$items.qty' } } },
        ])
        .toArray(),
      cameBack(db.collection('returns'), RETURN_SKIP, from),
      cameBack(db.collection('exchanges'), EXCHANGE_SKIP, from),
      latestNotes(db.collection('returns'), RETURN_SKIP, from),
      latestNotes(db.collection('exchanges'), EXCHANGE_SKIP, from),
    ]);

    const soldBy = new Map(sold.map((s) => [s._id.toString(), s.units]));
    const rows = new Map();
    const totals = new Map();
    const add = (kind, entries) => {
      for (const { _id, units, title } of entries) {
        const id = _id.productId.toString();
        const reason = `${kind}:${_id.reason}`;
        const row = rows.get(id) ?? {
          oid: _id.productId,
          productId: id,
          title,
          returned: 0,
          exchanged: 0,
          reasons: new Map(),
        };
        row[kind === 'return' ? 'returned' : 'exchanged'] += units;
        row.reasons.set(reason, (row.reasons.get(reason) ?? 0) + units);
        rows.set(id, row);
        totals.set(reason, (totals.get(reason) ?? 0) + units);
      }
    };
    add('return', returned);
    add('exchange', exchanged);

    const products = new Map(
      (
        await db
          .collection('products')
          .find({ _id: { $in: [...rows.values()].map((r) => r.oid) } }, { projection: { title: 1, slug: 1 } })
          .toArray()
      ).map((p) => [p._id.toString(), p]),
    );
    const byUnits = (a, b) => b.units - a.units || a.label.localeCompare(b.label);
    const reasonList = (map) =>
      [...map].map(([reason, units]) => ({ reason, label: LABELS[reason] ?? reason, units })).sort(byUnits);

    res.json({
      days,
      from,
      reasons: reasonList(totals),
      products: [...rows.values()]
        .map((r) => {
          const soldUnits = soldBy.get(r.productId) ?? 0;
          const back = r.returned + r.exchanged;
          return {
            productId: r.productId,
            slug: products.get(r.productId)?.slug ?? null,
            title: products.get(r.productId)?.title ?? r.title,
            sold: soldUnits,
            returned: r.returned,
            exchanged: r.exchanged,
            // Returned and exchanged units per 100 sold, to one decimal.
            rate: soldUnits ? Math.round((back * 1000) / soldUnits) / 10 : null,
            reasons: reasonList(r.reasons),
          };
        })
        .sort((a, b) => b.returned + b.exchanged - (a.returned + a.exchanged) || (b.rate ?? 0) - (a.rate ?? 0))
        .slice(0, MAX_ROWS),
      notes: [
        ...returnNotes.map((n) => ({ ...n, kind: 'return' })),
        ...exchangeNotes.map((n) => ({ ...n, kind: 'exchange' })),
      ]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, NOTES)
        .map((n) => ({
          id: n._id.toString(),
          kind: n.kind,
          orderId: n.orderId.toString(),
          number: n.orderNumber ?? null,
          titles: n.items.map((i) => i.title),
          label: LABELS[`${n.kind}:${n.reason}`] ?? n.reason,
          note: n.note,
          at: n.createdAt,
        })),
    });
  });

  return router;
}
