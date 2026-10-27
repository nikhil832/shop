import express from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { clientIp, hashToken, networkOf, requireAdmin } from './auth.js';
import { logActivity } from './activity.js';
import { parse } from './http.js';
import { takeHourlySlot } from './rateLimit.js';
import { searchStages } from './routes/catalog.js';

// Plain-words search (stage 62): when a search finds nothing (and "Did you mean…?" has nothing either), the search page
// asks GET /search/understand, and Claude turns the words ("running shoes under 2000") into the store's own filters:
// search words, a category and brands from the store's lists, a price range and in-stock. The page offers that search
// as a link, only when it finds something. Every visitor can cause a call, so: each distinct search is remembered for
// CACHE_DAYS (`searchInterpretations`, by a hash of the normalised words, results of null too), each visitor's network
// gets PER_HOUR new ones, and the store DAILY_CAP a day (India time; `settings` { _id: 'smartSearch', day, used,
// enabled }). Admins switch it off on the dashboard. Needs the writing assistant (ANTHROPIC_API_KEY).

export const PER_HOUR = 10;
export const DAILY_CAP = 300;
export const CACHE_DAYS = 7;
const SETTINGS_ID = 'smartSearch';
const IST_OFFSET = 330 * 60_000;
const today = (now) => new Date(now.getTime() + IST_OFFSET).toISOString().slice(0, 10);

const understandQuery = z.object({ q: z.string().trim().min(2).max(100) });
const normalise = (q) => q.toLowerCase().replace(/\s+/g, ' ').trim();
const cacheKey = (q) => createHash('sha256').update(normalise(q)).digest('base64url');

// Takes one of today's calls for the whole store, atomically: the counter starts again on a new day.
async function takeDailyCall(db, now) {
  const day = today(now);
  const doc = await db.collection('settings').findOneAndUpdate(
    { _id: SETTINGS_ID },
    [
      {
        $set: {
          used: {
            $cond: [
              { $ne: ['$day', day] },
              1,
              { $cond: [{ $lt: ['$used', DAILY_CAP] }, { $add: ['$used', 1] }, '$used'] },
            ],
          },
          taken: { $or: [{ $ne: ['$day', day] }, { $lt: ['$used', DAILY_CAP] }] },
          day,
        },
      },
    ],
    { upsert: true, returnDocument: 'after' },
  );
  return doc.taken;
}

// Claude's reading, checked against the store: only its own category slugs and brand names, whole-rupee prices in
// order, and words a search can use. Null when it adds nothing to the words typed.
export function checkReading(reading, q, { categories, brands }) {
  if (!reading?.understood) return null;
  const slugs = new Set(categories.map((c) => c.slug));
  const brandByLower = new Map(brands.map((b) => [b.toLowerCase(), b]));
  const price = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n) : null);
  let [min, max] = [price(reading.minPrice), price(reading.maxPrice)];
  if (min && max && min > max) [min, max] = [max, min];
  const search = {
    q: reading.words.replace(/\s+/g, ' ').trim().slice(0, 100),
    category: slugs.has(reading.category) ? reading.category : '',
    brand: [...new Set(reading.brands.map((b) => brandByLower.get(b.toLowerCase())).filter(Boolean))].join(','),
    minPrice: min ? String(min) : '',
    maxPrice: max ? String(max) : '',
    inStock: reading.inStock ? '1' : '',
  };
  const adds = search.category || search.brand || search.minPrice || search.maxPrice || search.inStock;
  if (!adds && normalise(search.q) === normalise(q)) return null;
  if (!adds && !search.q) return null;
  return search;
}

// How many shown products a reading finds, with the same rules as GET /products.
async function countFor(db, search) {
  const filter = { active: true };
  if (search.category) {
    const category = await db.collection('categories').findOne({ slug: search.category }, { projection: { _id: 1 } });
    if (!category) return 0;
    filter.categoryId = category._id;
  }
  if (search.q) filter.$and = (await searchStages(db.collection('categories'), search.q)).filter;
  if (search.minPrice || search.maxPrice) {
    filter.price = {};
    if (search.minPrice) filter.price.$gte = Number(search.minPrice) * 100;
    if (search.maxPrice) filter.price.$lte = Number(search.maxPrice) * 100;
  }
  if (search.inStock) filter.stock = { $gt: 0 };
  if (search.brand) filter.brand = { $in: search.brand.split(',') };
  return db.collection('products').countDocuments(filter);
}

const enabledIn = async (db) => (await db.collection('settings').findOne({ _id: SETTINGS_ID }))?.enabled !== false;

export function smartSearchRouter({ db, ai, config }) {
  const cache = db.collection('searchInterpretations');
  const router = express.Router();

  // { search: { q, category, brand, minPrice, maxPrice, inStock } (URL values; prices in rupees) and `total`, or
  // { search: null } when there's nothing better to offer (or it's off, or over a limit).
  router.get('/search/understand', async (req, res) => {
    const { q } = parse(understandQuery, req.query);
    const none = () => res.json({ search: null });
    if (!ai || !(await enabledIn(db))) return none();
    const _id = cacheKey(q);
    let saved = await cache.findOne({ _id });
    if (!saved) {
      const network = networkOf(clientIp(req, config));
      if (!(await takeHourlySlot(db, `smartSearch:${hashToken(network)}`, PER_HOUR))) return none();
      if (!(await takeDailyCall(db, new Date()))) return none();
      const [categories, brands] = await Promise.all([
        db
          .collection('categories')
          .find({}, { projection: { slug: 1, name: 1 } })
          .toArray(),
        db.collection('products').distinct('brand', { active: true }),
      ]);
      let search;
      try {
        search = checkReading(await ai.readSearch({ q, categories, brands }), q, { categories, brands });
      } catch (err) {
        // Not remembered, so a later visitor can try again.
        console.error('Could not read a search in plain words:', err.message);
        return none();
      }
      saved = { _id, search, at: new Date() };
      await cache.replaceOne({ _id }, saved, { upsert: true });
    }
    if (!saved.search) return none();
    const total = await countFor(db, saved.search);
    res.json(total ? { search: saved.search, total } : { search: null });
  });

  router.use('/admin/smart-search', requireAdmin);

  // For the dashboard: whether it can run (an API key), whether it's on, and today's calls.
  router.get('/admin/smart-search', async (req, res) => {
    const saved = await db.collection('settings').findOne({ _id: SETTINGS_ID });
    res.json({
      available: Boolean(ai),
      enabled: saved?.enabled !== false,
      usedToday: saved?.day === today(new Date()) ? saved.used : 0,
      dailyCap: DAILY_CAP,
    });
  });

  router.put('/admin/smart-search', async (req, res) => {
    const { enabled } = parse(z.object({ enabled: z.boolean('Say whether to use it: true or false') }), req.body);
    const before = await db
      .collection('settings')
      .findOneAndUpdate({ _id: SETTINGS_ID }, { $set: { enabled } }, { upsert: true, returnDocument: 'before' });
    if ((before?.enabled !== false) !== enabled) {
      await logActivity(db, req.user, {
        area: 'settings',
        action: enabled ? 'Switched on plain-words search' : 'Switched off plain-words search',
      });
    }
    res.json({ enabled });
  });

  return router;
}
