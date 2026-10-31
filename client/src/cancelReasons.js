// Why a customer cancels (stage 122): the same list as server/src/cancelReasons.js, which a test compares.
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

// ": Ordered by mistake (“note”)" for the admin timeline, or '' when no reason was given.
export function cancelReasonText(cancelReason) {
  if (!cancelReason) return '';
  return `: ${CANCEL_REASONS[cancelReason.reason] ?? cancelReason.reason}${cancelReason.note ? ` (“${cancelReason.note}”)` : ''}`;
}
