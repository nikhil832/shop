import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { request } from '../api.js';

// /confirm-order#token=… (stage 147), from the "Yes, ship it" button in a Cash on Delivery order's confirmation email.
// It works without logging in (the token is the key) and takes a click, not a page load, so a mail scanner opening
// the link confirms nothing.
export default function ConfirmOrder() {
  const token = new URLSearchParams(useLocation().hash.slice(1)).get('token') ?? '';
  const [state, setState] = useState({ busy: false, error: null, order: null });

  async function confirm() {
    setState({ busy: true, error: null, order: null });
    try {
      const order = await request('/cod-confirmations', { method: 'POST', body: { token } });
      setState({ busy: false, error: null, order });
    } catch (err) {
      setState({ busy: false, error: err.message, order: null });
    }
  }

  const order = state.order;
  const name = order?.number ? `Order #${order.number}` : 'Your order';
  return (
    <div className="auth-page">
      <div className="panel auth-form">
        <h1>Confirm your order</h1>
        {order ? (
          <p role="status">
            {order.status === 'placed'
              ? `Thank you! ${name} is confirmed, and we'll ship it soon. Please keep the cash ready for the delivery.`
              : `Thank you! ${name} is already on its way.`}
          </p>
        ) : (
          <>
            <p>Will you pay in cash when your order arrives? Confirm it and we&apos;ll ship it.</p>
            {state.error && (
              <p className="error" role="alert">
                {state.error}
              </p>
            )}
            {!token && (
              <p className="error" role="alert">
                This link is incomplete. Open it again from the email, or confirm on your order&apos;s page.
              </p>
            )}
            <button type="button" className="btn primary" onClick={confirm} disabled={state.busy || !token}>
              Yes, ship it
            </button>
          </>
        )}
        <p className="muted small">
          Changed your mind? You can cancel it from <Link to="/orders">your orders</Link> until it ships.
        </p>
      </div>
    </div>
  );
}
