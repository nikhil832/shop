import { useState } from 'react';
import { request } from '../api.js';
import OrderProgress from '../components/OrderProgress.jsx';
import { formatDate } from '../format.js';
import { ShipmentDetails } from './Order.jsx';
import { StatusBadge } from './Orders.jsx';

// /track (stage 108): where an order is, from its number and delivery PIN code, without logging in. Only the progress,
// tracking and item names come back (no prices or address).
export default function Track() {
  const [state, setState] = useState({ busy: false, error: null, order: null });

  async function submit(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null, order: null });
    try {
      const order = await request('/track', {
        method: 'POST',
        // "#100012" as printed in emails works too.
        body: { number: f.number.replace(/\D/g, ''), pincode: f.pincode },
      });
      setState({ busy: false, error: null, order });
    } catch (err) {
      setState({ busy: false, error: err.message, order: null });
    }
  }

  const { order } = state;
  return (
    <div className="track-page">
      <form className="panel track-form" onSubmit={submit} aria-labelledby="track-heading">
        <h1 id="track-heading">Track an order</h1>
        <p className="muted small">
          No need to log in: the order number is in the confirmation email, and the PIN code is the one it&apos;s being
          delivered to.
        </p>
        <div className="address-grid">
          <label>
            Order number
            <input name="number" inputMode="numeric" required maxLength={12} placeholder="100012" />
          </label>
          <label>
            Delivery PIN code
            <input name="pincode" inputMode="numeric" required pattern="[1-9][0-9]{5}" maxLength={6} />
          </label>
        </div>
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        <button type="submit" className="btn primary" disabled={state.busy}>
          {state.busy ? 'Looking…' : 'Track'}
        </button>
      </form>

      {order && (
        <section className="panel track-result" aria-labelledby="track-result-heading">
          <div className="order-head">
            <div>
              <h2 id="track-result-heading">Order #{order.number}</h2>
              <span className="muted small">
                Ordered on {formatDate(order.createdAt)}
                {order.cancelledAt &&
                  (order.returnedToSender
                    ? ` · came back undelivered on ${formatDate(order.cancelledAt)}`
                    : ` · cancelled on ${formatDate(order.cancelledAt)}`)}
              </span>
            </div>
            <StatusBadge status={order.status} />
          </div>
          <OrderProgress order={order} />
          {order.shipment && order.status !== 'cancelled' && <ShipmentDetails shipment={order.shipment} />}
          <h3>In this order</h3>
          <ul className="track-items">
            {order.items.map((i, n) => (
              <li key={n}>
                {i.title} × {i.qty}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
