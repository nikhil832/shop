import express from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { HttpError, parse, parseObjectId } from '../http.js';
import { logActivity } from '../activity.js';

// Where the store delivers, and how fast: areas by PIN code prefix ("560" = Bengaluru, 1–2 days; "79" = not
// delivered), the longest matching prefix winning, and a rule for everywhere else. Customers check a PIN on the product
// page; checkout refuses an address the store doesn't deliver to. With nothing set up, everywhere takes 3–7 days.
export const DEFAULT_RULE = { deliverable: true, minDays: 3, maxDays: 7, extraCharge: 0 };
const SETTINGS_ID = 'delivery';
const IST_OFFSET = 330 * 60_000;
const DAY = 86_400_000;

const pincode = z
  .string()
  .trim()
  .regex(/^[1-9]\d{5}$/, 'Enter a 6-digit PIN code');
const days = z.number().int().min(0).max(30);
// A rule: delivered in minDays–maxDays, or not delivered (then the days are ignored). `extraCharge` (stage 111, paise,
// whole rupees) is added to the delivery charge of orders to the area, even when delivery is otherwise free: couriers
// charge more for far-off places.
const rule = z
  .object({
    deliverable: z.boolean(),
    minDays: days.default(0),
    maxDays: days.default(0),
    extraCharge: z
      .number()
      .int()
      .min(0)
      .max(50_000, 'At most ₹500')
      .refine((n) => n % 100 === 0, 'Whole rupees only')
      .default(0),
  })
  .refine((r) => !r.deliverable || r.minDays <= r.maxDays, {
    message: "The fastest delivery can't be slower than the slowest",
    path: ['maxDays'],
  });
const zoneBody = z
  .object({
    prefix: z
      .string()
      .trim()
      .regex(/^[1-9]\d{0,5}$/, 'Enter the first 1–6 digits of the PIN codes'),
    name: z.string().trim().max(40).default(''),
  })
  .and(rule);

const toZone = (z) => ({
  id: z._id.toString(),
  prefix: z.prefix,
  name: z.name,
  deliverable: z.deliverable,
  minDays: z.minDays,
  maxDays: z.maxDays,
  extraCharge: z.extraCharge ?? 0,
});

// The rule for one PIN code: its longest matching area, or the one for everywhere else.
export async function deliveryFor(db, pin) {
  const prefixes = Array.from({ length: 6 }, (_, i) => pin.slice(0, i + 1));
  const [zones, settings] = await Promise.all([
    db
      .collection('deliveryZones')
      .find({ prefix: { $in: prefixes } })
      .toArray(),
    db.collection('settings').findOne({ _id: SETTINGS_ID }),
  ]);
  const zone = zones.sort((a, b) => b.prefix.length - a.prefix.length)[0];
  const r = zone ?? settings?.everywhereElse ?? DEFAULT_RULE;
  return {
    deliverable: r.deliverable,
    minDays: r.minDays,
    maxDays: r.maxDays,
    area: zone?.name || null,
    // Added to the delivery charge (stage 111); none where the store doesn't deliver.
    extraCharge: r.deliverable ? (r.extraCharge ?? 0) : 0,
  };
}

// "2026-10-27": the India-time date `n` days after `now`.
// "2–4 days", or "no delivery", for the activity log.
const ruleText = (r) =>
  r.deliverable
    ? `${r.minDays}–${r.maxDays} days${r.extraCharge ? `, +₹${(r.extraCharge / 100).toLocaleString('en-IN')}` : ''}`
    : 'no delivery';
const zoneText = (z) => `${z.prefix}${z.name ? ` (${z.name})` : ''}, ${ruleText(z)}`;

// The India-time date `n` days after `now`, as 'YYYY-MM-DD'.
export const istDate = (now, n) => new Date(now.getTime() + IST_OFFSET + n * DAY).toISOString().slice(0, 10);

export function deliveryRouter({ db }) {
  const zones = db.collection('deliveryZones');
  const settings = db.collection('settings');
  const router = express.Router();

  // For anyone: does the store deliver to this PIN, and by when (India-time dates, from today).
  router.get('/delivery', async (req, res) => {
    const pin = parse(z.object({ pincode }), req.query).pincode;
    const d = await deliveryFor(db, pin);
    const now = new Date();
    res.json({
      pincode: pin,
      ...d,
      ...(d.deliverable && { from: istDate(now, d.minDays), to: istDate(now, d.maxDays) }),
    });
  });

  // ---- Admin ----
  router.use('/admin/delivery', requireAdmin);

  router.get('/admin/delivery', async (req, res) => {
    const [list, doc] = await Promise.all([
      zones.find().sort({ prefix: 1 }).toArray(),
      settings.findOne({ _id: SETTINGS_ID }),
    ]);
    res.json({ everywhereElse: { ...DEFAULT_RULE, ...doc?.everywhereElse }, zones: list.map(toZone) });
  });

  router.put('/admin/delivery/everywhere-else', async (req, res) => {
    const r = parse(rule, req.body);
    const before = await settings.findOneAndUpdate(
      { _id: SETTINGS_ID },
      { $set: { everywhereElse: r, updatedAt: new Date() } },
      { upsert: true, returnDocument: 'before' },
    );
    const from = ruleText(before?.everywhereElse ?? DEFAULT_RULE);
    if (from !== ruleText(r)) {
      await logActivity(db, req.user, {
        area: 'delivery',
        action: 'Changed delivery everywhere else',
        target: { label: 'Other PIN codes', path: '/admin/delivery' },
        changes: [{ field: 'Delivery', from, to: ruleText(r) }],
      });
    }
    res.json({ everywhereElse: r });
  });

  router.post('/admin/delivery/zones', async (req, res) => {
    const body = parse(zoneBody, req.body);
    const doc = { ...body, createdAt: new Date() };
    try {
      const { insertedId } = await zones.insertOne(doc);
      await logActivity(db, req.user, {
        area: 'delivery',
        action: 'Added delivery area',
        target: { label: zoneText(doc), path: '/admin/delivery' },
      });
      res.status(201).json(toZone({ ...doc, _id: insertedId }));
    } catch (err) {
      if (err.code === 11000)
        throw new HttpError(409, `There is already an area for PIN codes starting ${body.prefix}`);
      throw err;
    }
  });

  router.put('/admin/delivery/zones/:id', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'area id');
    const body = parse(zoneBody, req.body);
    let before;
    try {
      before = await zones.findOneAndUpdate(
        { _id },
        { $set: { ...body, updatedAt: new Date() } },
        { returnDocument: 'before' },
      );
    } catch (err) {
      if (err.code === 11000)
        throw new HttpError(409, `There is already an area for PIN codes starting ${body.prefix}`);
      throw err;
    }
    if (!before) throw new HttpError(404, 'Area not found');
    const doc = { ...before, ...body };
    if (zoneText(before) !== zoneText(doc)) {
      await logActivity(db, req.user, {
        area: 'delivery',
        action: 'Changed delivery area',
        target: { label: zoneText(doc), path: '/admin/delivery' },
        changes: [{ field: 'Area', from: zoneText(before), to: zoneText(doc) }],
      });
    }
    res.json(toZone(doc));
  });

  router.delete('/admin/delivery/zones/:id', async (req, res) => {
    const deleted = await zones.findOneAndDelete({ _id: parseObjectId(req.params.id, 'area id') });
    if (!deleted) throw new HttpError(404, 'Area not found');
    await logActivity(db, req.user, {
      area: 'delivery',
      action: 'Deleted delivery area',
      target: { label: zoneText(deleted), path: null },
    });
    res.status(204).end();
  });

  return router;
}
