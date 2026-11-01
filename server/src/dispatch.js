import express from 'express';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { logActivity } from './activity.js';
import { parse } from './http.js';
import { holidaySettings } from './holiday.js';

// Ship-today countdown (stage 139): `settings` { _id: 'dispatch', enabled, cutoff ('HH:MM', India time), days
// (weekdays that orders go out, 0 = Sunday) }. Off until an admin switches it on. `dispatchState()` says whether an
// order placed now goes out today (before the cut-off on a working day that isn't in a store holiday, holiday.js) and
// until when, or else the next day it would; the product page counts down to the cut-off. Dates alone decide.
export const DISPATCH_ID = 'dispatch';
export const DEFAULTS = { enabled: false, cutoff: '14:00', days: [1, 2, 3, 4, 5, 6] };
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LOOK_AHEAD_DAYS = 70; // longer than any holiday (60 days) plus a week
const DAY = 86_400_000;
const IST_OFFSET = 330 * 60_000;

const dispatchBody = z.object({
  enabled: z.boolean(),
  cutoff: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'cutoff: Use a time like 14:00'),
  days: z
    .array(z.number().int().min(0).max(6))
    .min(1, 'days: Choose at least one day that orders go out')
    .refine((d) => new Set(d).size === d.length, 'days: Each day once')
    .transform((d) => [...d].sort()),
});

export async function dispatchSettings(db) {
  const doc = await db.collection('settings').findOne({ _id: DISPATCH_ID });
  return { ...DEFAULTS, ...doc };
}

const istDay = (time) => new Date(time + IST_OFFSET).toISOString().slice(0, 10);
const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();
const inBreak = (h, day) => Boolean(h?.from) && day >= h.from && day <= h.to;

// { shipsToday: true, cutoffAt } or { shipsToday: false, shipsOn ('YYYY-MM-DD'), tomorrow }; null when it's off or
// no working day comes within LOOK_AHEAD_DAYS.
export function dispatchState(s, holiday, now = new Date()) {
  if (!s.enabled) return null;
  const works = (day) => s.days.includes(weekday(day)) && !inBreak(holiday, day);
  const today = istDay(now.getTime());
  const cutoffAt = new Date(`${today}T${s.cutoff}:00+05:30`);
  if (works(today) && now < cutoffAt) return { shipsToday: true, cutoffAt };
  for (let n = 1; n <= LOOK_AHEAD_DAYS; n++) {
    const day = istDay(now.getTime() + n * DAY);
    if (works(day)) return { shipsToday: false, shipsOn: day, tomorrow: n === 1 };
  }
  return null;
}

const describe = (s) =>
  s.enabled ? `on, by ${s.cutoff} on ${s.days.map((d) => WEEKDAYS[d].slice(0, 3)).join(', ')}` : 'off';

export function dispatchRouter({ db }) {
  const router = express.Router();

  router.get('/dispatch', async (req, res) => {
    const [s, holiday] = await Promise.all([dispatchSettings(db), holidaySettings(db)]);
    res.json({ dispatch: dispatchState(s, holiday) });
  });

  router.get('/admin/dispatch', requireAdmin, async (req, res) => {
    const { enabled, cutoff, days } = await dispatchSettings(db);
    res.json({ enabled, cutoff, days });
  });

  router.put('/admin/dispatch', requireAdmin, async (req, res) => {
    const body = parse(dispatchBody, req.body);
    const before = await dispatchSettings(db);
    await db
      .collection('settings')
      .updateOne({ _id: DISPATCH_ID }, { $set: { ...body, updatedAt: new Date() } }, { upsert: true });
    if (describe(before) !== describe(body)) {
      await logActivity(db, req.user, {
        area: 'delivery',
        action: 'Changed the dispatch cut-off',
        target: { label: 'Ship-today countdown', path: '/admin/delivery' },
        changes: [{ field: 'Countdown', from: describe(before), to: describe(body) }],
      });
    }
    res.json(body);
  });

  return router;
}
