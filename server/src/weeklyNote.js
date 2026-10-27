import express from 'express';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { logActivity, rupees } from './activity.js';
import { sendToAdmins, weeklyNoteEmail } from './emails.js';
import { HttpError, parse } from './http.js';
import { takeHourlySlot } from './rateLimit.js';
import { AI_DRAFTS_PER_HOUR } from './routes/aiWriter.js';
import { LOW, lowStockProducts, SOLD } from './routes/dashboard.js';
import { OPEN_REPORTS } from './routes/errorReports.js';
import { UNANSWERED } from './routes/questions.js';

// The admins' weekly note (stage 58): each Monday from SEND_HOUR India time, an email about last week (Monday to
// Sunday) with a few paragraphs Claude writes from the week's figures, and the figures themselves below so they can be
// checked. index.js calls sendWeeklyNote every minute; the week is claimed in `settings` { _id: 'weeklyNote', week,
// at, enabled } before sending, like the low-stock email, so it goes once. The free plan sleeps, so it may come later
// in the week. Needs the writing assistant (ANTHROPIC_API_KEY); if Claude fails, the figures go alone. Admins switch it
// off on the dashboard (`enabled: false`) or send themselves one now.

export const SEND_HOUR = 9;
const SETTINGS_ID = 'weeklyNote';
const IST_OFFSET = 330 * 60_000;
const DAY = 86_400_000;
const BEST_SELLERS = 5;
const LOW_STOCK_LIST = 10;

// Midnight India time on the Monday of the week `now` is in.
export function weekStart(now) {
  const local = new Date(now.getTime() + IST_OFFSET);
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  const midnight = Math.floor(local.getTime() / DAY) * DAY - IST_OFFSET;
  return new Date(midnight - daysSinceMonday * DAY);
}
const isoDay = (time) => new Date(time + IST_OFFSET).toISOString().slice(0, 10);
const percent = (now, before) => (before ? Math.round(((now - before) / before) * 100) : null);

// Last week's figures (the week before the one `now` is in), with the week before that for comparison. Amounts in
// paise.
export async function weekFigures(db, now) {
  const to = weekStart(now);
  const from = new Date(to.getTime() - 7 * DAY);
  const before = new Date(from.getTime() - 7 * DAY);
  const inWeek = { $gte: from, $lt: to };
  const orders = db.collection('orders');
  const [[sales], [previous], bestSellers, cancelled, newCustomers, returnsRequested, newReviews, toShip, questions] =
    await Promise.all([
      orders
        .aggregate([
          { $match: { createdAt: inWeek, status: { $in: SOLD } } },
          {
            $group: {
              _id: null,
              revenue: { $sum: '$total' },
              orders: { $sum: 1 },
              itemsSold: { $sum: { $sum: '$items.qty' } },
              discount: { $sum: { $ifNull: ['$discount', 0] } },
            },
          },
        ])
        .toArray(),
      orders
        .aggregate([
          { $match: { createdAt: { $gte: before, $lt: from }, status: { $in: SOLD } } },
          { $group: { _id: null, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
        ])
        .toArray(),
      orders
        .aggregate([
          { $match: { createdAt: inWeek, status: { $in: SOLD } } },
          { $unwind: '$items' },
          {
            $group: {
              _id: '$items.productId',
              title: { $last: '$items.title' },
              qty: { $sum: '$items.qty' },
              sales: { $sum: { $multiply: ['$items.price', '$items.qty'] } },
            },
          },
          { $sort: { qty: -1, sales: -1, title: 1 } },
          { $limit: BEST_SELLERS },
        ])
        .toArray(),
      orders.countDocuments({ createdAt: inWeek, status: 'cancelled' }),
      db.collection('users').countDocuments({ createdAt: inWeek, role: 'user' }),
      db.collection('returns').countDocuments({ createdAt: inWeek }),
      db.collection('reviews').countDocuments({ createdAt: inWeek }),
      orders.countDocuments({ status: 'placed' }),
      db.collection('questions').countDocuments(UNANSWERED),
    ]);
  const [lowStock, lowStockCount, openErrors] = await Promise.all([
    lowStockProducts(db, LOW_STOCK_LIST),
    db.collection('products').countDocuments({ active: true, ...LOW }),
    db.collection('errorReports').countDocuments(OPEN_REPORTS),
  ]);
  return {
    from: isoDay(from.getTime()),
    to: isoDay(to.getTime() - 1),
    revenue: sales?.revenue ?? 0,
    orders: sales?.orders ?? 0,
    itemsSold: sales?.itemsSold ?? 0,
    discount: sales?.discount ?? 0,
    previous: { revenue: previous?.revenue ?? 0, orders: previous?.orders ?? 0 },
    cancelled,
    bestSellers: bestSellers.map((b) => ({ title: b.title, qty: b.qty, sales: b.sales })),
    newCustomers,
    returnsRequested,
    newReviews,
    toShip,
    questionsWaiting: questions,
    openErrors,
    lowStock: lowStock.map((p) => ({ title: p.title, stock: p.stock })),
    lowStockCount,
  };
}

// The figures as [label, value] lines, written for people: the email lists them, and Claude writes from exactly these,
// with the changes already worked out so it never has to calculate.
export function factLines(f) {
  const change = (now, before) => {
    const p = percent(now, before);
    return p === null ? '' : `, ${p >= 0 ? 'up' : 'down'} ${Math.abs(p)}%`;
  };
  return [
    [
      'Sales',
      `${rupees(f.revenue)} (week before: ${rupees(f.previous.revenue)}${change(f.revenue, f.previous.revenue)})`,
    ],
    ['Orders', `${f.orders} (week before: ${f.previous.orders}${change(f.orders, f.previous.orders)})`],
    ['Items sold', String(f.itemsSold)],
    ['Coupon discounts', rupees(f.discount)],
    ['Cancelled orders', String(f.cancelled)],
    [
      'Best sellers',
      f.bestSellers.length ? f.bestSellers.map((b) => `${b.title} × ${b.qty} (${rupees(b.sales)})`).join('; ') : 'none',
    ],
    ['New customer accounts', String(f.newCustomers)],
    ['Return requests', String(f.returnsRequested)],
    ['New reviews', String(f.newReviews)],
    ['Orders waiting to ship now', String(f.toShip)],
    ['Questions waiting for an answer now', String(f.questionsWaiting)],
    ['Open error reports now', String(f.openErrors)],
    [
      'Low stock now',
      f.lowStockCount
        ? `${f.lowStockCount} product(s): ${f.lowStock.map((p) => `${p.title} (${p.stock === 0 ? 'sold out' : `${p.stock} left`})`).join('; ')}${f.lowStockCount > f.lowStock.length ? '; and more' : ''}`
        : 'none',
    ],
  ];
}

// Builds the email: Claude's paragraphs when it writes them, the figures either way.
async function buildNote(ctx, now) {
  const figures = await weekFigures(ctx.db, now);
  const facts = factLines(figures);
  let paragraphs = null;
  try {
    paragraphs = await ctx.ai.writeWeeklyNote({ from: figures.from, to: figures.to, facts });
  } catch (err) {
    console.error('Could not write the weekly note; sending the figures alone:', err.message);
  }
  return weeklyNoteEmail(figures, facts, paragraphs, ctx.config.mail?.publicUrl);
}

// Returns what happened: 'off' (switched off or no API key), 'early' (Monday before SEND_HOUR), 'done' (this week's
// already sent or claimed) or 'sent'.
export async function sendWeeklyNote(ctx, now = new Date()) {
  const { db } = ctx;
  if (!ctx.ai) return 'off';
  const start = weekStart(now);
  if (now.getTime() < start.getTime() + SEND_HOUR * 3_600_000) return 'early';
  const week = isoDay(start.getTime());
  const settings = db.collection('settings');
  const saved = await settings.findOne({ _id: SETTINGS_ID });
  if (saved?.enabled === false) return 'off';
  if (saved?.week === week) return 'done';
  try {
    // Matches only if this week isn't claimed yet; otherwise the upsert tries to insert a second document with this _id.
    await settings.updateOne({ _id: SETTINGS_ID, week: { $ne: week } }, { $set: { week, at: now } }, { upsert: true });
  } catch (err) {
    if (err.code === 11000) return 'done';
    throw err;
  }
  await sendToAdmins(ctx, await buildNote(ctx, now), 'the weekly note');
  return 'sent';
}

const switchBody = z.object({ enabled: z.boolean('Say whether to send it: true or false') });

export function weeklyNoteRouter(ctx) {
  const { db } = ctx;
  const settings = db.collection('settings');
  const router = express.Router();
  router.use('/admin/weekly-note', requireAdmin);

  // For the dashboard: whether it can be sent (an API key) and whether it's on.
  router.get('/admin/weekly-note', async (req, res) => {
    const saved = await settings.findOne({ _id: SETTINGS_ID });
    res.json({ available: Boolean(ctx.ai), enabled: saved?.enabled !== false });
  });

  // Switches it on or off for every admin. Only a real change is logged.
  router.put('/admin/weekly-note', async (req, res) => {
    const { enabled } = parse(switchBody, req.body);
    const before = await settings.findOneAndUpdate(
      { _id: SETTINGS_ID },
      { $set: { enabled } },
      { upsert: true, returnDocument: 'before' },
    );
    if ((before?.enabled !== false) !== enabled) {
      await logActivity(db, req.user, {
        area: 'settings',
        action: enabled ? 'Switched on the weekly note' : 'Switched off the weekly note',
      });
    }
    res.json({ available: Boolean(ctx.ai), enabled });
  });

  // Sends last week's note now, to the admin asking only (to see what it's like). Uses the writing assistant's hourly
  // allowance, and doesn't count as this week's.
  router.post('/admin/weekly-note/send', async (req, res) => {
    if (!ctx.ai) {
      throw new HttpError(503, 'The writing assistant is off: the server has no ANTHROPIC_API_KEY.', { expose: true });
    }
    if (!(await takeHourlySlot(db, `aiDraft:${req.user._id}`, AI_DRAFTS_PER_HOUR))) {
      throw new HttpError(
        429,
        `You can ask the writing assistant ${AI_DRAFTS_PER_HOUR} times an hour. Try again later.`,
      );
    }
    const email = await buildNote(ctx, new Date());
    try {
      await ctx.mail.send({ to: { email: req.user.email, name: req.user.name }, ...email });
    } catch (err) {
      console.error('Could not send the weekly note:', err.message);
      throw new HttpError(502, "The email couldn't be sent. Try again later.", { expose: true });
    }
    res.status(204).end();
  });

  return router;
}
