import { useLocation } from 'react-router';
import { arrivalDay } from '../format.js';
import { useFetch } from '../useFetch.js';

// Not in the admin panel, nor on invoices and credit notes (printed): the same pages as the announcement bar.
const HIDDEN_ON = /^\/admin(\/|$)|^\/orders\/[^/]+\/(invoice|credit-notes)/;

// The words for a store holiday (stage 127), shared by the notice and checkout.
export function holidayText(h) {
  const when = `${arrivalDay(h.from)} to ${arrivalDay(h.to)}`;
  const after = h.takeOrders
    ? `Orders placed ${h.active ? 'now' : 'then'} ship from ${arrivalDay(h.reopens)}.`
    : `We're not taking orders ${h.active ? 'now' : 'then'}; we're back on ${arrivalDay(h.reopens)}.`;
  return `${h.active ? `We're on a break until ${arrivalDay(h.to)}.` : `We're away ${when}.`} ${after}`;
}

// Across the top of shop pages from a week before a store holiday until it ends (Admin → Delivery).
export default function HolidayNotice() {
  const { pathname } = useLocation();
  const { data } = useFetch('/holiday');
  const h = data?.holiday;
  if (!h || HIDDEN_ON.test(pathname)) return null;
  return (
    <aside className="announcement holiday-notice no-print" aria-label="Store holiday">
      <p>
        {holidayText(h)}
        {h.message && ` ${h.message}`}
      </p>
    </aside>
  );
}
