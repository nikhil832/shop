import express from 'express';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { logActivity } from './activity.js';
import { HttpError, parse, parseObjectId } from './http.js';
import { address } from './routes/orders.js';

// Click and collect (stage 146): `pickupPoints` { name, phone, line1, line2, city, state, pincode, hours, active,
// createdAt, updatedAt }, at most MAX_ACTIVE shown at once (checked like a checkout address, so the PIN code fits the
// state). While any is active, checkout offers "Pick up from …": no delivery charge, no PIN-code check, and the order's
// `address` is the point's with the customer's name and phone (so invoices, GST place of supply and slips need
// nothing else) plus `pickup` { pointId, name, hours, code }. The order's steps are the usual ones, worded for pickup
// by the client and emails: `shipped` is "ready for pickup" and `delivered` "collected", which an admin can only mark
// with the customer's 6-digit `code` (shown to the customer, never in admin responses).
export const MAX_ACTIVE = 5;

const pointBody = z.object({
  place: address, // name = the point's name, phone = its phone
  hours: z.string().trim().min(3, 'hours: Say when it is open, e.g. Mon–Sat 10 am–7 pm').max(100),
  active: z.boolean().default(true),
});

export const newPickupCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export const toPoint = (doc) => ({
  id: doc._id.toString(),
  name: doc.name,
  phone: doc.phone,
  line1: doc.line1,
  line2: doc.line2 ?? '',
  city: doc.city,
  state: doc.state,
  pincode: doc.pincode,
  hours: doc.hours,
  active: doc.active,
});

// The active point `id` (ObjectId or hex), or a 409 for checkout.
export async function pickupPoint(db, id, session) {
  const _id = typeof id === 'string' ? parseObjectId(id, 'pickup point') : id;
  const point = await db.collection('pickupPoints').findOne({ _id, active: true }, { session });
  if (!point) throw new HttpError(409, 'That pickup point is no longer available. Choose another or delivery');
  return point;
}

const describe = (p) => `${p.name}, ${p.line1}, ${p.city} (${p.hours})${p.active ? '' : ', not shown'}`;

export function pickupRouter({ db }) {
  const router = express.Router();
  const points = db.collection('pickupPoints');

  // For checkout: the points customers can choose.
  router.get('/pickup-points', async (req, res) => {
    const docs = await points.find({ active: true }).sort({ createdAt: 1 }).toArray();
    res.json({ items: docs.map(toPoint) });
  });

  router.use('/admin/pickup-points', requireAdmin);

  router.get('/admin/pickup-points', async (req, res) => {
    const docs = await points.find().sort({ createdAt: 1 }).toArray();
    res.json({ items: docs.map(toPoint), maxActive: MAX_ACTIVE });
  });

  const fields = (body) => ({
    name: body.place.name,
    phone: body.place.phone,
    line1: body.place.line1,
    line2: body.place.line2,
    city: body.place.city,
    state: body.place.state,
    pincode: body.place.pincode,
    hours: body.hours,
    active: body.active,
  });
  const assertRoom = async (except) => {
    const shown = await points.countDocuments({ active: true, ...(except && { _id: { $ne: except } }) });
    if (shown >= MAX_ACTIVE) throw new HttpError(409, `At most ${MAX_ACTIVE} pickup points can be shown at once`);
  };

  router.post('/admin/pickup-points', async (req, res) => {
    const doc = fields(parse(pointBody, req.body));
    if (doc.active) await assertRoom();
    const now = new Date();
    const { insertedId } = await points.insertOne({ ...doc, createdAt: now, updatedAt: now });
    await logActivity(db, req.user, {
      area: 'delivery',
      action: 'Added pickup point',
      target: { label: doc.name, path: '/admin/delivery' },
      changes: [{ field: 'Pickup point', to: describe(doc) }],
    });
    res.status(201).json(toPoint({ _id: insertedId, ...doc }));
  });

  router.put('/admin/pickup-points/:id', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'pickup point');
    const doc = fields(parse(pointBody, req.body));
    if (doc.active) await assertRoom(_id);
    const before = await points.findOneAndUpdate({ _id }, { $set: { ...doc, updatedAt: new Date() } });
    if (!before) throw new HttpError(404, 'Pickup point not found');
    if (describe(before) !== describe(doc)) {
      await logActivity(db, req.user, {
        area: 'delivery',
        action: 'Changed pickup point',
        target: { label: doc.name, path: '/admin/delivery' },
        changes: [{ field: 'Pickup point', from: describe(before), to: describe(doc) }],
      });
    }
    res.json(toPoint({ _id, ...doc }));
  });

  return router;
}
