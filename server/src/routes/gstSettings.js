import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { HttpError, parse } from '../http.js';
import { logActivity, yesNo } from '../activity.js';
import { findState, GST_RATES, GST_SETTINGS, gstinProblem, INDIAN_STATES } from '../gst.js';

// Admin → GST: the store's GSTIN, name, address and state, a default rate, and each category's rate and HSN code.
// Switching GST on needs all of the store's details; orders placed from then on get tax invoices (gst.js).

const rate = z.number().refine((r) => GST_RATES.includes(r), `Choose a rate: ${GST_RATES.join(', ')} %`);
const hsn = z
  .string()
  .trim()
  .regex(/^(\d{4}|\d{6}|\d{8})?$/, 'An HSN code is 4, 6 or 8 digits');
const gstBody = z.object({
  enabled: z.boolean(),
  gstin: z.string().trim().toUpperCase().max(15).default(''),
  legalName: z.string().trim().max(120).default(''),
  address: z.string().trim().max(400).default(''),
  state: z.string().trim().max(60).default(''),
  defaultRate: rate.nullable().default(null),
  categories: z
    .array(z.object({ id: z.string().regex(/^[0-9a-f]{24}$/), rate: rate.nullable(), hsn }))
    .max(200)
    .default([]),
});

const DEFAULTS = { enabled: false, gstin: '', legalName: '', address: '', state: '', defaultRate: null };
const rateText = (r) => (r === null || r === undefined ? 'default' : `${r}%`);

export function gstSettingsRouter({ db }) {
  const settings = db.collection('settings');
  const categories = db.collection('categories');
  const router = express.Router();
  router.use('/admin/gst', requireAdmin);

  async function current() {
    const [doc, cats] = await Promise.all([
      settings.findOne({ _id: GST_SETTINGS }),
      categories.find().sort({ sortOrder: 1, name: 1 }).toArray(),
    ]);
    return {
      ...DEFAULTS,
      ...(doc && {
        enabled: doc.enabled,
        gstin: doc.gstin,
        legalName: doc.legalName,
        address: doc.address,
        state: doc.state,
        defaultRate: doc.defaultRate,
      }),
      categories: cats.map((c) => ({
        id: c._id.toString(),
        name: c.name,
        rate: c.gst?.rate ?? null,
        hsn: c.gst?.hsn ?? '',
      })),
      rates: GST_RATES,
      states: INDIAN_STATES.map((s) => s.name),
    };
  }

  router.get('/admin/gst', async (req, res) => res.json(await current()));

  router.put('/admin/gst', async (req, res) => {
    const body = parse(gstBody, req.body);
    const state = body.state ? findState(body.state) : null;
    if (body.state && !state) throw new HttpError(400, 'state: Choose a state or union territory from the list');
    if (body.gstin) {
      const problem = gstinProblem(body.gstin);
      if (problem) throw new HttpError(400, `gstin: ${problem}`);
      if (state && body.gstin.slice(0, 2) !== state.code) {
        throw new HttpError(400, `gstin: A GSTIN from ${state.name} starts with ${state.code}`);
      }
    }
    if (body.enabled) {
      const missing = [
        !body.gstin && 'GSTIN',
        !body.legalName && 'business name',
        !body.address && 'address',
        !state && 'state',
        body.defaultRate === null && 'default rate',
      ].filter(Boolean);
      if (missing.length) throw new HttpError(400, `To switch GST on, enter the ${missing.join(', ')}`);
    }
    const known = new Map((await categories.find().toArray()).map((c) => [c._id.toString(), c]));
    if (body.categories.some((c) => !known.has(c.id)))
      throw new HttpError(400, 'categories: A category no longer exists');

    const before = await current();
    const fields = { ...body, state: state?.name ?? '' };
    delete fields.categories;
    await settings.updateOne({ _id: GST_SETTINGS }, { $set: { ...fields, updatedAt: new Date() } }, { upsert: true });
    if (body.categories.length) {
      await categories.bulkWrite(
        body.categories.map((c) => ({
          updateOne: {
            filter: { _id: new ObjectId(c.id) },
            update:
              c.rate === null && !c.hsn ? { $unset: { gst: '' } } : { $set: { gst: { rate: c.rate, hsn: c.hsn } } },
          },
        })),
      );
    }
    const after = await current();

    const changes = [];
    const push = (field, from, to) => from !== to && changes.push({ field, from, to });
    push('GST on', yesNo(before.enabled), yesNo(after.enabled));
    push('GSTIN', before.gstin, after.gstin);
    push('Business name', before.legalName, after.legalName);
    if (before.address !== after.address) changes.push({ field: 'Address', to: 'edited' });
    push('State', before.state, after.state);
    push('Default rate', rateText(before.defaultRate), rateText(after.defaultRate));
    for (const c of after.categories) {
      const old = before.categories.find((b) => b.id === c.id);
      if (!old) continue;
      push(`${c.name}: rate`, rateText(old.rate), rateText(c.rate));
      push(`${c.name}: HSN`, old.hsn, c.hsn);
    }
    if (changes.length) await logActivity(db, req.user, { area: 'settings', action: 'Changed GST settings', changes });
    res.json(after);
  });

  return router;
}
