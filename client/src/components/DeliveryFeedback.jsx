import { useState } from 'react';
import { request } from '../api.js';
import { DELIVERY_RATINGS, MAX_NOTE, feedbackOpen } from '../deliveryFeedback.js';

// "How was your delivery?" on a delivered order (stage 123), for FEEDBACK_DAYS after it arrived. Once answered it
// thanks the customer and offers to change the answer while the window is open. `onDone(order)` shows the saved order.
export default function DeliveryFeedback({ order, onDone }) {
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState({ busy: false, error: null });
  const open = feedbackOpen(order.deliveredAt);
  const given = order.deliveryFeedback;
  if (!given && !open) return null;

  async function submit(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const rating = form.get('rating');
    if (!rating) {
      setState({ busy: false, error: 'Choose how the delivery went first.' });
      return;
    }
    const note = form.get('note').trim();
    setState({ busy: true, error: null });
    try {
      const saved = await request(`/orders/${order.id}/delivery-feedback`, {
        method: 'POST',
        body: { rating, ...(note && { note }) },
      });
      setState({ busy: false, error: null });
      setEditing(false);
      onDone(saved);
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <section className="panel delivery-feedback" aria-labelledby="delivery-feedback-heading">
      <h2 id="delivery-feedback-heading">How was your delivery?</h2>
      {given && !editing ? (
        <>
          <p>
            Thanks for telling us: {DELIVERY_RATINGS[given.rating].toLowerCase()}.
            {given.note && <span className="muted block">&ldquo;{given.note}&rdquo;</span>}
          </p>
          {open && (
            <button type="button" className="btn small" onClick={() => setEditing(true)}>
              Change my answer
            </button>
          )}
        </>
      ) : (
        <form onSubmit={submit} aria-label="Delivery feedback">
          <fieldset>
            <legend className="sr-only">How was your delivery?</legend>
            {Object.entries(DELIVERY_RATINGS).map(([key, label]) => (
              <label key={key} className="radio-line">
                <input type="radio" name="rating" value={key} defaultChecked={given?.rating === key} />
                {label}
              </label>
            ))}
          </fieldset>
          <label>
            Anything to add? (optional)
            <textarea name="note" rows={2} maxLength={MAX_NOTE} defaultValue={given?.note ?? ''} />
          </label>
          {state.error && (
            <p className="error" role="alert">
              {state.error}
            </p>
          )}
          <p className="muted small">It helps us choose the couriers that look after your orders.</p>
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={state.busy}>
              Send
            </button>
            {given && (
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                Keep my answer
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
