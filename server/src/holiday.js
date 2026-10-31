import express from 'express';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { logActivity } from './activity.js';
import { HttpError, parse } from './http.js';

// Holiday mode (stage 127): `settings` { _id: 'holiday', from, to ('YYYY-MM-DD', India-time days, both included),
// message, takeOrders }. Nothing ships between the two days, so delivery dates for orders placed during the break
// count from the day after it (`dispatchDelay`); with `takeOrders: false` checkout is closed meanwhile. The shop shows
// a notice from NOTICE_DAYS before the break until it ends. Dates alone decide, nothing runs on a timer; a break that
// has ended is simply ignored until the admin sets a new one.
export const HOLIDAY_ID = 'holiday';
export const NOTICE_DAYS = 7;
export const MAX_DAYS = 60;
const DAY = 86_400_000;
const IST_OFFSET = 330 * 60_000;

const today = (now) => new Date(now.getTime() + IST_OFFSET).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

const realDay = (v) => {
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
};
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-01')
  .refine(realDay, 'That date is not in the calendar');
const holidayBody = z
  .object({
    from: day,
    to: day,
    message: z.string().trim().max(160, 'Keep the message to 160 characters').default(''),
    takeOrders: z.boolean('Say whether orders are taken during the break: true or false'),
  })
  .refine((h) => h.from <= h.to, { message: 'to: The break must end on or after its first day', path: ['to'] })
  .refine((h) => daysBetween(h.from, h.to) < MAX_DAYS, {
    message: `to: A break can be at most ${MAX_DAYS} days`,
    path: ['to'],
  });

export const holidaySettings = (db) => db.collection('settings').findOne({ _id: HOLIDAY_ID });

// The break as the shop sees it at `now`: { from, to, message, takeOrders, active, reopens } while it is coming up
// (within NOTICE_DAYS) or on, else null. `reopens` is the first day back.
export function holidayState(h, now = new Date()) {
  if (!h?.from) return null;
  const d = today(now);
  if (d > h.to || d < addDays(h.from, -NOTICE_DAYS)) return null;
  return {
    from: h.from,
    to: h.to,
    message: h.message ?? '',
    takeOrders: h.takeOrders,
    active: d >= h.from,
    reopens: addDays(h.to, 1),
  };
}

// Days to add to delivery dates for an order placed at `at`: until the day after the break, if it's on.
export function dispatchDelay(h, at = new Date()) {
  if (!h?.from) return 0;
  const d = today(at);
  return d >= h.from && d <= h.to ? daysBetween(d, addDays(h.to, 1)) : 0;
}

// Refuses an order while the break is on and orders are paused.
export function assertTakingOrders(h, now = new Date()) {
  const state = holidayState(h, now);
  if (state?.active && !state.takeOrders) {
    throw new HttpError(
      409,
      `We're on a break, so we aren't taking orders until ${state.reopens}. Please come back then.`,
    );
  }
}

const describe = (h) =>
  h?.from
    ? `${h.from} to ${h.to}, ${h.takeOrders ? 'orders taken' : 'orders paused'}${h.message ? `: ${h.message}` : ''}`
    : 'none';

export function holidayRouter({ db }) {
  const router = express.Router();
  const settings = db.collection('settings');

  router.get('/holiday', async (req, res) => {
    res.json({ holiday: holidayState(await holidaySettings(db)) });
  });

  router.get('/admin/holiday', requireAdmin, async (req, res) => {
    const h = await holidaySettings(db);
    res.json({ holiday: h?.from ? { from: h.from, to: h.to, message: h.message, takeOrders: h.takeOrders } : null });
  });

  router.put('/admin/holiday', requireAdmin, async (req, res) => {
    const h = parse(holidayBody, req.body);
    if (h.to < today(new Date())) throw new HttpError(400, 'to: That break has already ended');
    const before = await settings.findOneAndUpdate(
      { _id: HOLIDAY_ID },
      { $set: { ...h, updatedAt: new Date() } },
      { upsert: true, returnDocument: 'before' },
    );
    if (describe(before) !== describe(h)) {
      await logActivity(db, req.user, {
        area: 'delivery',
        action: 'Set a store holiday',
        target: { label: 'Holiday mode', path: '/admin/delivery' },
        changes: [{ field: 'Holiday', from: describe(before), to: describe(h) }],
      });
    }
    res.json({ holiday: { from: h.from, to: h.to, message: h.message, takeOrders: h.takeOrders } });
  });

  router.delete('/admin/holiday', requireAdmin, async (req, res) => {
    const before = await settings.findOneAndDelete({ _id: HOLIDAY_ID });
    if (before?.from) {
      await logActivity(db, req.user, {
        area: 'delivery',
        action: 'Ended the store holiday',
        target: { label: 'Holiday mode', path: '/admin/delivery' },
        changes: [{ field: 'Holiday', from: describe(before), to: 'none' }],
      });
    }
    res.status(204).end();
  });

  return router;
}
