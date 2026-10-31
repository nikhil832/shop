// "How was your delivery?" (stage 123): the same choices and days as server/src/deliveryFeedback.js (a test compares).
export const DELIVERY_RATINGS = {
  on_time: 'On time and in good condition',
  late: 'It came late',
  damaged: 'The package was damaged',
};
export const FEEDBACK_DAYS = 30;
export const MAX_NOTE = 200;

// Whether an order delivered at `deliveredAt` can still be answered about.
export const feedbackOpen = (deliveredAt) => Date.now() - new Date(deliveredAt).getTime() < FEEDBACK_DAYS * 86_400_000;
