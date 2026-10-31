import express from 'express';
import { z } from 'zod';
import { requireAdmin, requireUser } from './auth.js';
import { HttpError, parse, parseObjectId } from './http.js';
import { toOrder } from './routes/orders.js';

// "How was your delivery?" (stage 123). For FEEDBACK_DAYS after delivery the customer's order page asks how it went;
// the answer is kept on the order as `deliveryFeedback` { rating, note?, at } (answering again replaces it). Admins see
// the answers per courier (`shipment.courier`, as typed when shipping; grouped ignoring case and spaces at the ends),
// next to how many orders came after the date promised at checkout (`deliveryEstimate.to`), which needs no answer.
// `client/src/deliveryFeedback.js` has the same list and days (a test compares them).
export const DELIVERY_RATINGS = {
  on_time: 'On time and in good condition',
  late: 'It came late',
  damaged: 'The package was damaged',
};
export const FEEDBACK_DAYS = 30;
export const MAX_NOTE = 200;
const NOTES = 10;
const DAY = 86_400_000;
const IST_OFFSET = 330 * 60_000;

const feedbackBody = z.object({
  rating: z.enum(Object.keys(DELIVERY_RATINGS), 'Choose how the delivery went'),
  note: z.string().trim().max(MAX_NOTE, `Keep the note to ${MAX_NOTE} characters`).optional(),
});
const reportQuery = z.object({ days: z.enum(['30', '90', '365']).default('90') });

// India-time midnight `days − 1` days before today, so the period includes today.
function periodStart(now, days) {
  const today = new Date(Math.floor((now.getTime() + IST_OFFSET) / DAY) * DAY - IST_OFFSET);
  return new Date(today.getTime() - (days - 1) * DAY);
}

export function deliveryFeedbackRouter({ db }) {
  const router = express.Router();
  const orders = db.collection('orders');

  router.post('/orders/:id/delivery-feedback', requireUser, async (req, res) => {
    const _id = parseObjectId(req.params.id, 'order id');
    const { rating, note } = parse(feedbackBody, req.body);
    const now = new Date();
    const order = await orders.findOneAndUpdate(
      {
        _id,
        userId: req.user._id,
        status: 'delivered',
        deliveredAt: { $gte: new Date(now.getTime() - FEEDBACK_DAYS * DAY) },
      },
      { $set: { deliveryFeedback: { rating, ...(note && { note }), at: now }, updatedAt: now } },
      { returnDocument: 'after' },
    );
    if (!order) {
      const existing = await orders.findOne({ _id, userId: req.user._id });
      if (!existing) throw new HttpError(404, 'Order not found');
      if (existing.status !== 'delivered')
        throw new HttpError(409, 'You can tell us about the delivery once it arrives');
      throw new HttpError(409, `Delivery feedback is open for ${FEEDBACK_DAYS} days after delivery`);
    }
    res.json(toOrder(order));
  });

  router.get('/admin/delivery-feedback', requireAdmin, async (req, res) => {
    const days = Number(parse(reportQuery, req.query).days);
    const from = periodStart(new Date(), days);
    const delivered = { status: 'delivered', deliveredAt: { $gte: from } };
    const count = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
    const rated = (rating) => count({ $eq: ['$deliveryFeedback.rating', rating] });
    const [couriers, notes] = await Promise.all([
      orders
        .aggregate([
          { $match: delivered },
          { $addFields: { courierName: { $trim: { input: { $ifNull: ['$shipment.courier', ''] } } } } },
          {
            $group: {
              _id: { $toLower: '$courierName' },
              name: { $first: '$courierName' },
              delivered: { $sum: 1 },
              answers: count({ $ne: [{ $type: '$deliveryFeedback' }, 'missing'] }),
              onTime: rated('on_time'),
              late: rated('late'),
              damaged: rated('damaged'),
              withDate: count({ $ne: [{ $type: '$deliveryEstimate.to' }, 'missing'] }),
              afterDate: count({
                $and: [
                  { $ne: [{ $type: '$deliveryEstimate.to' }, 'missing'] },
                  {
                    $gt: [
                      { $dateToString: { date: '$deliveredAt', format: '%Y-%m-%d', timezone: 'Asia/Kolkata' } },
                      '$deliveryEstimate.to',
                    ],
                  },
                ],
              }),
            },
          },
          { $sort: { delivered: -1, _id: 1 } },
        ])
        .toArray(),
      orders
        .find(
          { ...delivered, 'deliveryFeedback.note': { $type: 'string' } },
          { projection: { number: 1, shipment: 1, deliveryFeedback: 1 } },
        )
        .sort({ 'deliveryFeedback.at': -1 })
        .limit(NOTES)
        .toArray(),
    ]);
    res.json({
      days,
      from,
      // `courier` '' is orders shipped without a courier name.
      couriers: couriers.map(({ name, delivered, answers, onTime, late, damaged, withDate, afterDate }) => ({
        courier: name,
        delivered,
        answers,
        onTime,
        late,
        damaged,
        withDate,
        afterDate,
      })),
      notes: notes.map((o) => ({
        orderId: o._id.toString(),
        number: o.number ?? null,
        courier: o.shipment?.courier?.trim() ?? '',
        rating: o.deliveryFeedback.rating,
        note: o.deliveryFeedback.note,
        at: o.deliveryFeedback.at,
      })),
    });
  });

  return router;
}
