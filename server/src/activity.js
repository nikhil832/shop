import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { parse } from './http.js';
import { optionsOf } from './variants.js';

// The admin activity log: who changed what, and when. Each admin route that changes something calls logActivity()
// after the change is saved, as do the command-line scripts that grant admin or switch off two-step login. Entries are
// { at, by: { id, name, email } or null (command line), area, action, target: { label, path } or null,
// changes: [{ field, from?, to }] } with values already written for people ("₹2,499"), so old entries read the same
// whatever changes later. Kept for a year (TTL index), never edited or deleted through the API.

export const ACTIVITY_AREAS = [
  'products',
  'categories',
  'orders',
  'returns',
  'reviews',
  'questions',
  'coupons',
  'delivery',
  'settings',
  'accounts',
  'errors',
  'help',
  'sales',
  'announcements',
  'giftCards',
  'bundles',
  'collections',
];
export const ACTIVITY_DAYS = 365;
const MAX_CHANGES = 100;
const PAGE = 50;

// Records one entry. Never throws: the change it describes is already saved, so a failure here is only logged.
export async function logActivity(db, user, { area, action, target = null, changes = [] }) {
  try {
    await db.collection('activity').insertOne({
      at: new Date(),
      by: user ? { id: user._id, name: user.name, email: user.email } : null,
      area,
      action,
      target,
      changes:
        changes.length > MAX_CHANGES
          ? [
              ...changes.slice(0, MAX_CHANGES),
              { field: 'And more', to: `${changes.length - MAX_CHANGES} more changes` },
            ]
          : changes,
    });
  } catch (err) {
    console.error(`Could not record "${action}" in the activity log:`, err.message);
  }
}

// ---- Writing values for people ----

export const rupees = (paise) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const yesNo = (b) => (b ? 'yes' : 'no');
export const orderLabel = (order) => `Order #${order.number ?? order._id.toString().slice(-8).toUpperCase()}`;
export const orderTarget = (order) => ({ label: orderLabel(order), path: `/admin/orders/${order._id}` });
export const productTarget = (product) => ({ label: product.title, path: `/admin/products/${product._id}` });

// Adds { field, from, to } when the two differ (compared as written).
function push(changes, field, from, to) {
  if (String(from) !== String(to)) changes.push({ field, from: String(from), to: String(to) });
}

// What changed in a product, from the documents before and after: its fields, photos, and each variant's price, MRP
// and stock by label (and variants added or removed). `categoryName(id)` names categories.
// A cost price (stage 80) for the log: none is "(none)".
const costText = (cost) => (cost === undefined || cost === null ? '(none)' : rupees(cost));

export function productChanges(before, after, categoryName) {
  const changes = [];
  push(changes, 'Title', before.title, after.title);
  push(changes, 'Brand', before.brand, after.brand);
  push(changes, 'Category', categoryName(before.categoryId), categoryName(after.categoryId));
  if ((before.description ?? '') !== (after.description ?? '')) changes.push({ field: 'Description', to: 'edited' });
  push(changes, 'Highlights', (before.highlights ?? []).join(' | '), (after.highlights ?? []).join(' | '));
  if (JSON.stringify(before.images) !== JSON.stringify(after.images)) {
    changes.push({ field: 'Photos', from: String(before.images.length), to: `${after.images.length} (changed)` });
  }
  if (JSON.stringify(before.imageAlts ?? {}) !== JSON.stringify(after.imageAlts ?? {})) {
    changes.push({ field: 'Photo descriptions', to: 'edited' });
  }
  push(changes, 'Shown', yesNo(before.active), yesNo(after.active));
  // "Coming soon" (stage 92), with its expected day if any.
  const soon = (doc) =>
    doc.comingSoon ? `yes${doc.comingSoon.expected ? `, expected ${doc.comingSoon.expected}` : ''}` : 'no';
  push(changes, 'Coming soon', soon(before), soon(after));
  // Quantity discount (stage 99).
  const offer = (doc) =>
    doc.quantityDiscount ? `${doc.quantityDiscount.percent}% off from ${doc.quantityDiscount.minQty}` : 'none';
  push(changes, 'Quantity discount', offer(before), offer(after));

  const variantsBefore = before.variants ?? [];
  const variantsAfter = after.variants ?? [];
  if (!variantsBefore.length && !variantsAfter.length) {
    push(changes, 'Price', rupees(before.price), rupees(after.price));
    push(changes, 'MRP', rupees(before.mrp), rupees(after.mrp));
    push(changes, 'Stock', before.stock, after.stock);
    push(changes, 'Cost', costText(before.cost), costText(after.cost));
    return changes;
  }
  const names = (doc) => (doc.variants?.length ? optionsOf(doc).join(', ') : '(none)');
  push(changes, 'Options', names(before), names(after));
  const byId = new Map(variantsBefore.map((v) => [v._id.toString(), v]));
  for (const v of variantsAfter) {
    const old = byId.get(v._id.toString());
    byId.delete(v._id.toString());
    if (!old) {
      changes.push({ field: `${v.label}`, to: `added: ${rupees(v.price)}, MRP ${rupees(v.mrp)}, stock ${v.stock}` });
      continue;
    }
    push(changes, `${v.label}: name`, old.label, v.label);
    push(changes, `${v.label}: price`, rupees(old.price), rupees(v.price));
    push(changes, `${v.label}: MRP`, rupees(old.mrp), rupees(v.mrp));
    push(changes, `${v.label}: stock`, old.stock, v.stock);
    push(changes, `${v.label}: cost`, costText(old.cost), costText(v.cost));
  }
  for (const v of byId.values()) changes.push({ field: v.label, to: 'removed' });
  return changes;
}

// ---- The admin page ----

const activityQuery = z.object({
  area: z.enum(ACTIVITY_AREAS).optional(),
  // An admin's id, or "cli" for the command line.
  by: z
    .string()
    .regex(/^([0-9a-f]{24}|cli)$/, 'Choose a person')
    .optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

const toEntry = (doc) => ({
  id: doc._id.toString(),
  at: doc.at,
  by: doc.by ? { id: doc.by.id.toString(), name: doc.by.name, email: doc.by.email } : null,
  area: doc.area,
  action: doc.action,
  target: doc.target,
  changes: doc.changes,
});

export function activityRouter({ db }) {
  const activity = db.collection('activity');
  const router = express.Router();
  router.use('/admin/activity', requireAdmin);

  // Newest first, 50 a page, by area and person; `people` lists everyone in the log, for the filter.
  router.get('/admin/activity', async (req, res) => {
    const query = parse(activityQuery, req.query);
    const filter = {};
    if (query.area) filter.area = query.area;
    if (query.by === 'cli') filter.by = null;
    else if (query.by) filter['by.id'] = new ObjectId(query.by);
    const [docs, total, people] = await Promise.all([
      activity
        .find(filter)
        .sort({ at: -1, _id: -1 })
        .skip((query.page - 1) * PAGE)
        .limit(PAGE)
        .toArray(),
      activity.countDocuments(filter),
      activity
        .aggregate([
          { $sort: { at: -1 } },
          { $group: { _id: '$by.id', name: { $first: '$by.name' }, email: { $first: '$by.email' } } },
          { $sort: { name: 1 } },
        ])
        .toArray(),
    ]);
    res.json({
      items: docs.map(toEntry),
      total,
      page: query.page,
      pageSize: PAGE,
      people: people.map((p) => (p._id ? { id: p._id.toString(), name: p.name, email: p.email } : { id: 'cli' })),
    });
  });

  return router;
}
