import express from 'express';
import { z } from 'zod';
import { clientIp, hashToken, networkOf } from '../auth.js';
import { HttpError, parse } from '../http.js';
import { takeHourlySlot } from '../rateLimit.js';

// Tracking an order without logging in (stage 108): its number and the delivery PIN code find it, for gift
// recipients and anyone on another device. Only where it is is shown (status, dates, the promised arrival, the
// courier's tracking) and the items' names: no prices, payment, name or address. The PIN code makes a number alone
// useless, and each network may try LOOKUPS_PER_HOUR times an hour (every try counts, found or not); a wrong number
// and a wrong PIN code get the same answer.
export const LOOKUPS_PER_HOUR = 20;

const trackBody = z.object({
  number: z.coerce.number('Enter the order number').int('Enter the order number').min(1).max(99_999_999),
  pincode: z
    .string()
    .trim()
    .regex(/^[1-9]\d{5}$/, 'Enter the 6-digit PIN code it was sent to'),
});

export function orderTrackingRouter({ db, config }) {
  const router = express.Router();

  router.post('/track', async (req, res) => {
    const body = parse(trackBody, req.body);
    const network = networkOf(clientIp(req, config));
    if (!(await takeHourlySlot(db, `track:${hashToken(network)}`, LOOKUPS_PER_HOUR))) {
      throw new HttpError(429, 'Too many tries for now. Please try again in an hour.');
    }
    const order = await db.collection('orders').findOne({ number: body.number, 'address.pincode': body.pincode });
    if (!order) throw new HttpError(404, "We couldn't find an order with that number and PIN code.");
    res.json({
      number: order.number,
      status: order.status,
      createdAt: order.createdAt,
      shippedAt: order.shippedAt ?? null,
      deliveredAt: order.deliveredAt ?? null,
      cancelledAt: order.cancelledAt ?? null,
      deliveryEstimate: order.deliveryEstimate ?? null,
      shipment: order.shipment ?? null,
      returnedToSender: Boolean(order.returnedToSender),
      items: order.items.map((i) => ({ title: i.title, qty: i.qty })),
    });
  });

  return router;
}
