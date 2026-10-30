import { useState } from 'react';
import { useAuth } from '../auth.jsx';
import { useFetch } from '../useFetch.js';

const KEY = 'bazaar.pincode';
const dayFormat = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
// The API's India-time dates ("2026-10-27") as "Mon, 27 Oct".
const formatDay = (date) => dayFormat.format(new Date(date));

function savedPin() {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

// "Check delivery" on the product page: whether the store delivers to a PIN code and by when. Starts with the saved
// address's PIN, or the last one checked in this browser: it waits for the login check, and starts again for a new user.
export default function DeliveryCheck() {
  const { user } = useAuth();
  if (user === undefined) return null;
  return <Check key={user?.id ?? 'guest'} initial={user?.address?.pincode ?? savedPin()} />;
}

function Check({ initial }) {
  // The PIN being shown, once checked; the field itself is uncontrolled.
  const [pin, setPin] = useState(/^[1-9]\d{5}$/.test(initial) ? initial : null);
  const [invalid, setInvalid] = useState(false);
  const { data, error, loading } = useFetch(pin ? `/delivery?pincode=${pin}` : null);

  function submit(e) {
    e.preventDefault();
    const value = new FormData(e.currentTarget).get('pincode').trim();
    if (!/^[1-9]\d{5}$/.test(value)) return setInvalid(true);
    setInvalid(false);
    setPin(value);
    try {
      localStorage.setItem(KEY, value);
    } catch {
      // Storage blocked: it just isn't remembered.
    }
  }

  return (
    <form className="delivery-check" onSubmit={submit} aria-label="Check delivery">
      <label htmlFor="delivery-pin">Check delivery</label>
      <div className="delivery-input">
        <input
          id="delivery-pin"
          name="pincode"
          inputMode="numeric"
          autoComplete="postal-code"
          maxLength={6}
          placeholder="PIN code"
          defaultValue={initial}
        />
        <button type="submit" className="btn small">
          Check
        </button>
      </div>
      {/* Read out when it changes; not role="status", which the page's own messages (stock alerts…) use. */}
      <p className="small delivery-result" aria-live="polite">
        {invalid
          ? 'Enter a 6-digit PIN code'
          : error
            ? error.message
            : loading || !data
              ? ''
              : data.deliverable
                ? `Delivered to ${data.pincode}${data.area ? ` (${data.area})` : ''} by ${
                    data.from === data.to ? formatDay(data.to) : `${formatDay(data.from)} – ${formatDay(data.to)}`
                  }${data.extraCharge ? `, ₹${(data.extraCharge / 100).toLocaleString('en-IN')} extra for delivery there` : ''}`
                : `Sorry, we don't deliver to ${data.pincode} yet.`}
      </p>
    </form>
  );
}
