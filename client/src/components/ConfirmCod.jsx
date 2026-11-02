import { useState } from 'react';
import { request } from '../api.js';
import { formatPrice } from '../format.js';

// "Yes, ship it" on the customer's order page (stage 147): a Cash on Delivery order the store asks them to confirm,
// while it's placed and not confirmed. Its message is `aria-live`, not role="status": the order page's own notices are
// the status messages tests look for.
export default function ConfirmCod({ order }) {
  const [state, setState] = useState({ busy: false, error: null, done: false });
  const c = order.codConfirm;
  if (!c || order.status !== 'placed' || (c.confirmedAt && !state.done)) return null;

  async function confirm() {
    setState({ busy: true, error: null, done: false });
    try {
      await request(`/orders/${order.id}/confirm-cod`, { method: 'POST' });
      setState({ busy: false, error: null, done: true });
    } catch (err) {
      setState({ busy: false, error: err.message, done: false });
    }
  }

  return (
    <section className="notice awaiting confirm-cod" aria-labelledby="confirm-cod">
      <h2 id="confirm-cod">Confirm your order</h2>
      <p aria-live="polite">
        {state.done
          ? "Thank you! Your order is confirmed, and we'll ship it soon."
          : `Please confirm you'll pay ${formatPrice(order.total - order.creditUsed)} in cash on delivery, so we can ship it. If we don't hear from you within a day, we'll call you.`}
      </p>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {!state.done && (
        <div className="notice-actions">
          <button type="button" className="btn primary small" onClick={confirm} disabled={state.busy}>
            Yes, ship it
          </button>
        </div>
      )}
    </section>
  );
}
