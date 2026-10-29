import express from 'express';
import { requireAdmin, requireUser } from '../auth.js';
import { logActivity } from '../activity.js';
import { sendAddressChanged } from '../emails.js';
import { HttpError, parse, parseObjectId } from '../http.js';
import { deliveryFor, istDate } from './delivery.js';
import { address, toOrder } from './orders.js';

// Changing an order's delivery address before it ships (stage 90), by its customer or an admin. The new address must
// be one the store delivers to; the delivery dates are worked out again from the day the order was placed with the new
// area's days (orders from before stage 86 have none and get none). The previous addresses are kept in
// `addressChanges` [{ from, at, by: { id, name }, role: 'customer' | 'admin' }], at most MAX_CHANGES, and shown to
// admins only. The customer is always emailed (a change they didn't make shows up); admins are emailed when the
// customer changed it (a packing slip may be printed); admin changes go in the activity log.
export const MAX_CHANGES = 5;
const CHANGEABLE = ['awaiting_payment', 'placed'];
const FIELDS = ['name', 'phone', 'line1', 'line2', 'city', 'state', 'pincode'];

const sameAddress = (a, b) => FIELDS.every((f) => (a[f] ?? '') === (b[f] ?? ''));
const oneLine = (a) =>
  [a.name, a.line1, a.line2, a.city, `${a.state} ${a.pincode}`, a.phone].filter(Boolean).join(', ');

// Sets `next` as the address of the order matching `filter`, or throws 404/409. Returns { order (after), previous }.
async function changeAddress(db, filter, next, user, role) {
  const orders = db.collection('orders');
  const order = await orders.findOne(filter);
  if (!order) throw new HttpError(404, 'Order not found');
  if (!CHANGEABLE.includes(order.status)) {
    throw new HttpError(409, `The address can only be changed before the order ships; this one is ${order.status}`);
  }
  if (sameAddress(order.address, next)) throw new HttpError(400, 'That is already the delivery address');
  if ((order.addressChanges?.length ?? 0) >= MAX_CHANGES) {
    throw new HttpError(
      409,
      `This order's address has been changed ${MAX_CHANGES} times. Please contact us to change it again.`,
    );
  }
  const delivery = await deliveryFor(db, next.pincode);
  if (!delivery.deliverable) throw new HttpError(409, `Sorry, we don't deliver to ${next.pincode} yet.`);

  const now = new Date();
  const after = await orders.findOneAndUpdate(
    // The status, the address read and the count in the filter: a change, shipment or cancellation meanwhile wins.
    {
      _id: order._id,
      status: { $in: CHANGEABLE },
      address: order.address,
      [`addressChanges.${MAX_CHANGES - 1}`]: { $exists: false },
    },
    {
      $set: {
        address: next,
        ...(order.deliveryEstimate && {
          deliveryEstimate: {
            from: istDate(order.createdAt, delivery.minDays),
            to: istDate(order.createdAt, delivery.maxDays),
          },
        }),
        updatedAt: now,
      },
      $push: { addressChanges: { from: order.address, at: now, by: { id: user._id, name: user.name }, role } },
    },
    { returnDocument: 'after' },
  );
  if (!after) throw new HttpError(409, 'The order changed meanwhile. Reload the page and try again.');
  return { order: after, previous: order.address };
}

export function orderAddressRouter(ctx) {
  const { db } = ctx;
  const router = express.Router();

  router.post('/orders/:id/address', requireUser, async (req, res) => {
    const next = parse(address, req.body);
    const filter = { _id: parseObjectId(req.params.id, 'order id'), userId: req.user._id };
    const { order, previous } = await changeAddress(db, filter, next, req.user, 'customer');
    await sendAddressChanged(ctx, order, previous, false);
    res.json(toOrder(order));
  });

  router.post('/admin/orders/:id/address', requireAdmin, async (req, res) => {
    const next = parse(address, req.body);
    const { order, previous } = await changeAddress(
      db,
      { _id: parseObjectId(req.params.id, 'order id') },
      next,
      req.user,
      'admin',
    );
    await logActivity(db, req.user, {
      area: 'orders',
      action: 'Changed delivery address',
      target: {
        label: `Order #${order.number ?? order._id.toString().slice(-8).toUpperCase()}`,
        path: `/admin/orders/${order._id}`,
      },
      changes: [{ field: 'Address', from: oneLine(previous), to: oneLine(order.address) }],
    });
    await sendAddressChanged(ctx, order, previous, true);
    res.json(toOrder(order, { admin: true }));
  });

  return router;
}
