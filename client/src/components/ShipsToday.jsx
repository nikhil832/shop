import { useEffect, useState } from 'react';
import { useFetch } from '../useFetch.js';

// Ship-today countdown (stage 139): "Order within 2 h 15 min to ship today" until the store's cut-off, else when the
// next parcels go out. Nothing while the store has it off. The clock is kept in state and moved on every 30 seconds
// (render stays pure); past the cut-off the line is left out until the page is loaded again.
const DAY_NAME = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

export function timeLeft(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h && `${h} h`, m && `${m} min`].filter(Boolean).join(' ');
}

export default function ShipsToday() {
  const { data } = useFetch('/dispatch');
  const [now, setNow] = useState(() => Date.now());
  const dispatch = data?.dispatch;
  useEffect(() => {
    if (!dispatch?.shipsToday) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [dispatch]);
  if (!dispatch) return null;
  if (dispatch.shipsToday) {
    const left = new Date(dispatch.cutoffAt).getTime() - now;
    if (left <= 0) return null;
    return (
      <p className="ships-today">
        Order within <strong>{timeLeft(left)}</strong> to ship today
      </p>
    );
  }
  return (
    <p className="ships-today">
      {dispatch.tomorrow ? 'Ships tomorrow' : `Ships on ${DAY_NAME.format(new Date(`${dispatch.shipsOn}T00:00:00Z`))}`}
    </p>
  );
}
