import express from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { hashToken, requireUser } from './auth.js';
import { requirePermission } from './staff.js';
import { HttpError, parse, parseObjectId } from './http.js';
import { logActivity, orderTarget } from './activity.js';

// Confirming Cash on Delivery orders (stage 147). With `settings` { _id: 'cod', confirm: true } (cod.js), a COD order
// delivered to an address (not a pickup, not paid in full with credit) gets `codConfirm` { tokenHash, confirmedAt:
// null }, and its confirmation email a "Yes, ship it" link (`/confirm-order#token=…`, confirmed on a click, not on
// load, as mail scanners open links) that works without logging in. The customer can also confirm on the order page.
// Orders still not confirmed CALL_AFTER_MS after ordering are listed for an admin to call (`UNCONFIRMED`: the admin
// orders list's `confirm=waiting`, the dashboard's `codToCall`), who marks them "Confirmed by phone". Nothing is
// refused: shipping an unconfirmed order is the admin's choice. `by` is { role: 'customer' } or { role: 'staff', id,
// name }.

export const CALL_AFTER_MS = 24 * 60 * 60 * 1000;

// A new order's confirmation: the token for its email, and what the order keeps (only the token's hash).
export function newCodConfirm() {
  const token = randomBytes(18).toString('base64url');
  return { token, codConfirm: { tokenHash: hashToken(`codconfirm:${token}`), confirmedAt: null } };
}

// Orders an admin should call about: still placed and unconfirmed a day after ordering.
export const UNCONFIRMED = (now = new Date()) => ({
  status: 'placed',
  'codConfirm.tokenHash': { $exists: true },
  'codConfirm.confirmedAt': null,
  createdAt: { $lte: new Date(now.getTime() - CALL_AFTER_MS) },
});

// What an order response says (toOrder): null when it never needed confirming.
export function toCodConfirm(doc, admin, now = new Date()) {
  const c = doc.codConfirm;
  if (!c) return null;
  return {
    confirmedAt: c.confirmedAt ?? null,
    by: c.by?.role ?? null,
    ...(admin && { byName: c.by?.name ?? null }),
    // Waiting for a call: still placed, unconfirmed, and ordered at least a day ago.
    callNow: !c.confirmedAt && doc.status === 'placed' && now - doc.createdAt >= CALL_AFTER_MS,
  };
}

// Confirms the order matching `filter`. Returns { order, changed }; an order already confirmed, or already shipped,
// counts as confirmed (changed: false). Throws 404 for no such order, 409 for one that's cancelled or never needed it.
async function confirmCod(db, filter, by) {
  const orders = db.collection('orders');
  const now = new Date();
  const order = await orders.findOneAndUpdate(
    { ...filter, status: 'placed', 'codConfirm.tokenHash': { $exists: true }, 'codConfirm.confirmedAt': null },
    { $set: { 'codConfirm.confirmedAt': now, 'codConfirm.by': by, updatedAt: now } },
    { returnDocument: 'after' },
  );
  if (order) return { order, changed: true };
  const existing = await orders.findOne(filter);
  if (!existing) throw new HttpError(404, 'Order not found');
  if (!existing.codConfirm) throw new HttpError(409, "This order doesn't need confirming");
  if (existing.status === 'cancelled')
    throw new HttpError(409, 'This order was cancelled, so there is nothing to confirm');
  return { order: existing, changed: false };
}

// Only what the confirmation page needs, as the link works without logging in.
const confirmed = (order) => ({
  number: order.number ?? null,
  status: order.status,
  confirmedAt: order.codConfirm.confirmedAt ?? null,
});

const tokenBody = z.object({ token: z.string().regex(/^[\w-]{20,40}$/, 'This link is incomplete') });

export function codConfirmRouter({ db }) {
  const router = express.Router();

  // From the email's link: no login, the token is the key.
  router.post('/cod-confirmations', async (req, res) => {
    const { token } = parse(tokenBody, req.body);
    const filter = { 'codConfirm.tokenHash': hashToken(`codconfirm:${token}`) };
    const { order } = await confirmCod(db, filter, { role: 'customer' }).catch((err) => {
      // An unknown token is the same 404 whatever it is, worded for someone following a link.
      if (err.status === 404) throw new HttpError(404, "This link doesn't match an order. It may have been mistyped.");
      throw err;
    });
    res.json(confirmed(order));
  });

  // From the order page, logged in. Someone else's order is not found, like the other order routes.
  router.post('/orders/:id/confirm-cod', requireUser, async (req, res) => {
    const filter = { _id: parseObjectId(req.params.id, 'order id'), userId: req.user._id };
    const { order } = await confirmCod(db, filter, { role: 'customer' });
    res.json(confirmed(order));
  });

  // An admin, or support or packing staff, who called the customer.
  router.post('/admin/orders/:id/confirm-cod', requirePermission('orders.notes'), async (req, res) => {
    const filter = { _id: parseObjectId(req.params.id, 'order id') };
    const { order, changed } = await confirmCod(db, filter, {
      role: 'staff',
      id: req.user._id,
      name: req.user.name,
    });
    if (changed) {
      await logActivity(db, req.user, { area: 'orders', action: 'Confirmed by phone', target: orderTarget(order) });
    }
    res.json(confirmed(order));
  });

  return router;
}
