import express from 'express';
import { z } from 'zod';
import { requireUser } from './auth.js';
import { savedSearchEmail } from './emails.js';
import { HttpError, parse, parseObjectId } from './http.js';
import { listFilters, listQuery, toProductCard } from './routes/catalog.js';

// Saved searches (stage 144): a logged-in customer saves a search page's words and filters ("Tell me about new
// arrivals") and gets an email when products added after it match. `savedSearches` { userId, params (the search
// page's URL values: prices in rupees, `spec` a list), key (the params in a fixed order, unique per user), label,
// createdAt, checkedAt, notified (product ids already told about, the latest MAX_NOTIFIED) }. Matching goes through
// listFilters, the same as GET /products. The minute sweep checks each search at most once an hour.
export const MAX_SAVED = 10;
const CHECK_EVERY_MS = 3_600_000;
const BATCH = 100;
const PER_SEARCH = 6;
const MAX_NOTIFIED = 500;
const KEYS = ['q', 'category', 'brand', 'size', 'spec', 'minPrice', 'maxPrice', 'rating', 'inStock', 'deals'];

const body = z.object({ search: z.string().max(1000) });

// The search page's URL values, only those a search keeps (no page or order), checked like GET /products.
function readParams(search) {
  const url = new URLSearchParams(search.replace(/^\?/, ''));
  const params = {};
  for (const key of KEYS) {
    if (key === 'spec') {
      const specs = url.getAll('spec').filter(Boolean);
      if (specs.length) params.spec = specs;
    } else if (url.get(key)) params[key] = url.get(key).trim();
  }
  if (!Object.keys(params).length) throw new HttpError(400, 'Search for something or choose a filter first');
  parse(listQuery, apiQuery(params)); // 400 for anything GET /products would refuse
  return params;
}

// GET /products' query for these params: prices in paise.
const apiQuery = (params) => ({
  ...params,
  ...(params.minPrice && { minPrice: String(Math.round(Number(params.minPrice) * 100)) }),
  ...(params.maxPrice && { maxPrice: String(Math.round(Number(params.maxPrice) * 100)) }),
});
const keyOf = (params) =>
  KEYS.filter((k) => params[k] !== undefined)
    .map(
      (k) =>
        `${k}=${[params[k]]
          .flat()
          .map((v) => v.toLowerCase())
          .sort()
          .join('|')}`,
    )
    .join('&');
// The search page's address for these params.
export const searchPath = (params) => {
  const url = new URLSearchParams();
  for (const key of KEYS) for (const v of [params[key] ?? []].flat()) url.append(key, v);
  return `/search?${url}`;
};

// "“running shoes” in Fashion · Stride · ₹1,000–₹3,000 · size UK 8 · RAM 8 GB · deals · in stock · 4★ & up".
async function labelOf(db, params) {
  const category = params.category
    ? await db.collection('categories').findOne({ slug: params.category }, { projection: { name: 1 } })
    : null;
  const money = (r) => `₹${Number(r).toLocaleString('en-IN')}`;
  const price =
    params.minPrice && params.maxPrice
      ? `${money(params.minPrice)}–${money(params.maxPrice)}`
      : params.minPrice
        ? `from ${money(params.minPrice)}`
        : params.maxPrice
          ? `under ${money(params.maxPrice)}`
          : null;
  const words = [
    params.q ? `“${params.q}”${category ? ` in ${category.name}` : ''}` : (category?.name ?? null),
    params.brand?.split(',').join(', '),
    price,
    params.size && `size ${params.size.split(',').join(', ')}`,
    ...(params.spec ?? []).map((s) => s.replace(':', ' ')),
    params.deals && 'deals',
    params.inStock && 'in stock',
    params.rating && `${params.rating}★ & up`,
  ].filter(Boolean);
  return (words.join(' · ') || 'All products').slice(0, 200);
}

const toSaved = (doc) => ({
  id: doc._id.toString(),
  label: doc.label,
  path: searchPath(doc.params),
  createdAt: doc.createdAt,
});

export function savedSearchRouter({ db }) {
  const router = express.Router();
  const saved = db.collection('savedSearches');
  router.use('/saved-searches', requireUser);

  router.get('/saved-searches', async (req, res) => {
    const docs = await saved.find({ userId: req.user._id }).sort({ createdAt: -1 }).toArray();
    res.json({ items: docs.map(toSaved), max: MAX_SAVED });
  });

  router.post('/saved-searches', async (req, res) => {
    const params = readParams(parse(body, req.body).search);
    const key = keyOf(params);
    const userId = req.user._id;
    const existing = await saved.findOne({ userId, key });
    if (existing) return res.json(toSaved(existing));
    if ((await saved.countDocuments({ userId })) >= MAX_SAVED) {
      throw new HttpError(409, `You can save up to ${MAX_SAVED} searches. Remove one on your account page first`);
    }
    const doc = {
      userId,
      params,
      key,
      label: await labelOf(db, params),
      createdAt: new Date(),
      notified: [],
    };
    try {
      const { insertedId } = await saved.insertOne(doc);
      res.status(201).json(toSaved({ _id: insertedId, ...doc }));
    } catch (err) {
      // The same search saved from two tabs at once.
      if (err.code !== 11000) throw err;
      res.json(toSaved(await saved.findOne({ userId, key })));
    }
  });

  router.delete('/saved-searches/:id', async (req, res) => {
    await saved.deleteOne({ _id: parseObjectId(req.params.id, 'saved search id'), userId: req.user._id });
    res.status(204).end();
  });

  return router;
}

// Run every minute: each saved search not checked for an hour looks for products added after it was saved that
// match it, are shown and in stock, and weren't told about yet; one email per customer lists them. Returns emails sent.
export async function sendSavedSearchAlerts(ctx, now = new Date()) {
  const { db } = ctx;
  const saved = db.collection('savedSearches');
  const due = await saved
    .find({ $or: [{ checkedAt: { $exists: false } }, { checkedAt: { $lte: new Date(now - CHECK_EVERY_MS) } }] })
    .sort({ checkedAt: 1, _id: 1 })
    .limit(BATCH)
    .toArray();
  const byUser = new Map();
  for (const search of due) {
    // Claimed first, so two sweeps don't both check it.
    const claimed = await saved.updateOne(
      { _id: search._id, checkedAt: search.checkedAt ?? { $exists: false } },
      { $set: { checkedAt: now } },
    );
    if (!claimed.modifiedCount) continue;
    const filters = await listFilters(db, parse(listQuery, apiQuery(search.params)));
    if (!filters) continue; // its category is gone
    const found = await db
      .collection('products')
      .find({
        ...filters.match,
        stock: { $gt: 0 },
        createdAt: { $gt: search.createdAt },
        _id: { $nin: search.notified ?? [] },
      })
      .sort({ createdAt: -1 })
      .limit(PER_SEARCH)
      .toArray();
    if (!found.length) continue;
    const key = search.userId.toString();
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push({ search, products: found });
  }
  let sent = 0;
  for (const groups of byUser.values()) {
    const user = await db.collection('users').findOne({ _id: groups[0].search.userId });
    if (!user) continue;
    try {
      const email = savedSearchEmail(
        user,
        groups.map((g) => ({
          label: g.search.label,
          path: searchPath(g.search.params),
          products: g.products.map(toProductCard),
        })),
        ctx.config.mail?.publicUrl,
      );
      await ctx.mail.send({ to: { email: user.email, name: user.name }, ...email });
      sent++;
    } catch (err) {
      // Not marked as told, so the next check (an hour later) tries again.
      console.error(`Could not send saved-search news to user ${user._id}:`, err.message);
      continue;
    }
    for (const g of groups) {
      await saved.updateOne(
        { _id: g.search._id },
        { $push: { notified: { $each: g.products.map((p) => p._id), $slice: -MAX_NOTIFIED } } },
      );
    }
  }
  return sent;
}
