import { useState } from 'react';
import { CANCEL_REASONS, MAX_NOTE } from '../cancelReasons.js';

// "Cancel order" on the customer's order page (stage 122): asks why before cancelling, so the dashboard can show the
// main reasons. `cancel({ reason, note })` sends it; `paid` says the payment will be refunded.
export default function CancelOrder({ paid, busy, cancel }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)} disabled={busy}>
        Cancel order
      </button>
    );
  }
  function submit(e) {
    e.preventDefault();
    if (!reason) {
      setMissing(true);
      return;
    }
    const note = new FormData(e.currentTarget).get('note').trim();
    cancel({ reason, ...(note && { note }) });
  }
  return (
    <form className="cancel-order" onSubmit={submit} aria-label="Cancel this order">
      <fieldset>
        <legend>Why are you cancelling?</legend>
        {Object.entries(CANCEL_REASONS).map(([key, label]) => (
          <label key={key} className="radio-line">
            <input
              type="radio"
              name="reason"
              value={key}
              checked={reason === key}
              onChange={() => {
                setReason(key);
                setMissing(false);
              }}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {reason === 'address' && (
        <p className="muted small">You can also change the delivery address on this page until the order ships.</p>
      )}
      <label>
        Anything we could do better? (optional)
        <textarea name="note" rows={2} maxLength={MAX_NOTE} />
      </label>
      {missing && (
        <p className="error" role="alert">
          Choose a reason first.
        </p>
      )}
      <p className="muted small">
        {paid ? 'Your payment will be refunded in full.' : 'Its items will be put back on sale.'}
      </p>
      <div className="form-actions">
        <button type="submit" className="btn danger" disabled={busy}>
          Confirm cancellation
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)} disabled={busy}>
          Keep my order
        </button>
      </div>
    </form>
  );
}
