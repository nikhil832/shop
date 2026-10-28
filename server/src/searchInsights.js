import express from 'express';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { parse } from './http.js';

// Search insights (stage 76): what shoppers search for, per week, and what finds nothing, so admins know what to stock
// or which words to add to titles and highlights. Collection `searchStats`: one document per week and search,
// { week ('YYYY-MM-DD', its Monday in India time), term (lower case, single spaces), count, found (products the latest
// one found), lastAt }, unique on (week, term). Words only: nothing about who searched. GET /products records a search
// when it's a plain one (page 1, no filters, the default sort), so paging, sorting and filtering don't count it again.
// A week keeps at most MAX_TERMS different searches (a script can't fill it); entries go after KEEP_DAYS.

export const MAX_TERMS = 1000;
export const KEEP_DAYS = 182;
const LIST = 50;
const WEEKS = 12;
const DAY = 86_400_000;
const IST_OFFSET = 330 * 60_000;

// The Monday (India time) of `now`'s week, as 'YYYY-MM-DD'. weeklyNote.js has the same; not imported from there, as
// catalog.js imports this module and weeklyNote.js leads back to it through the dashboard.
export function weekOf(now) {
  const local = new Date(now.getTime() + IST_OFFSET);
  const monday = Math.floor(local.getTime() / DAY) * DAY - ((local.getUTCDay() + 6) % 7) * DAY;
  return new Date(monday).toISOString().slice(0, 10);
}
export const normalTerm = (q) => q.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 100);

// Counts one search. Never throws: a search answers whether or not it was counted.
export async function recordSearch(db, q, found, now = new Date()) {
  const term = normalTerm(q);
  if (term.length < 2) return;
  const week = weekOf(now);
  const stats = db.collection('searchStats');
  try {
    if (!(await stats.findOne({ week, term }, { projection: { _id: 1 } }))) {
      if ((await stats.countDocuments({ week })) >= MAX_TERMS) return;
    }
    await stats.updateOne({ week, term }, { $inc: { count: 1 }, $set: { found, lastAt: now } }, { upsert: true });
  } catch (err) {
    if (err.code !== 11000) console.error('Could not count a search:', err.message); // 11000: counted at the same moment
  }
}

const insightsQuery = z.object({ week: z.iso.date('Choose a week').optional() });

export function searchInsightsRouter({ db }) {
  const stats = db.collection('searchStats');
  const router = express.Router();
  router.use('/admin/search-insights', requireAdmin);

  // One week (this one unless `week` is given): totals, the most searched, and those that found nothing.
  router.get('/admin/search-insights', async (req, res) => {
    const { week = weekOf(new Date()) } = parse(insightsQuery, req.query);
    const toTerm = (d) => ({ term: d.term, count: d.count, found: d.found });
    const [top, none, [totals], weeks] = await Promise.all([
      stats.find({ week }).sort({ count: -1, lastAt: -1 }).limit(LIST).toArray(),
      stats.find({ week, found: 0 }).sort({ count: -1, lastAt: -1 }).limit(LIST).toArray(),
      stats
        .aggregate([
          { $match: { week } },
          {
            $group: {
              _id: null,
              searches: { $sum: '$count' },
              different: { $sum: 1 },
              nothingFound: { $sum: { $cond: [{ $eq: ['$found', 0] }, '$count', 0] } },
            },
          },
        ])
        .toArray(),
      stats.distinct('week'),
    ]);
    const thisWeek = weekOf(new Date());
    res.json({
      week,
      // Weeks with searches, newest first, always including this one, for the picker.
      weeks: [...new Set([thisWeek, ...weeks])].sort().reverse().slice(0, WEEKS),
      totals: {
        searches: totals?.searches ?? 0,
        different: totals?.different ?? 0,
        nothingFound: totals?.nothingFound ?? 0,
      },
      top: top.map(toTerm),
      nothingFound: none.map(toTerm),
    });
  });

  return router;
}
