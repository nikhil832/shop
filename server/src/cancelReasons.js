import { z } from 'zod';

// Why a customer cancels their order (stage 122). Kept on the order as `cancelReason` { reason, note? } and counted on
// the dashboard. `client/src/cancelReasons.js` has the same list for the form (a test compares them). Imports nothing,
// so orders.js and dashboard.js can both use it.
export const CANCEL_REASONS = {
  mistake: 'Ordered by mistake',
  wrong_item: 'Chose the wrong item, size or colour',
  cheaper: 'Found it cheaper elsewhere',
  too_slow: 'Delivery will take too long',
  address: 'Need a different address or details',
  payment: 'Want to pay another way',
  changed_mind: 'Changed my mind',
  other: 'Something else',
};
export const MAX_NOTE = 200;

// The reason is optional for the API (a page loaded before this stage sends none); the form asks for one.
export const cancelBody = z
  .object({
    reason: z.enum(Object.keys(CANCEL_REASONS), 'Choose a reason from the list').optional(),
    note: z.string().trim().max(MAX_NOTE, `Keep the note to ${MAX_NOTE} characters`).optional(),
  })
  .default({});

// What's stored on the order, or null when the customer gave nothing.
export function cancelReasonOf({ reason, note }) {
  if (!reason && !note) return null;
  return { reason: reason ?? 'other', ...(note && { note }) };
}
