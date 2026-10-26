import { useState } from 'react';
import { lineKey } from '../cart.js';
import { Link, Navigate, useLocation, useParams } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';
import OrderSummary from '../components/OrderSummary.jsx';
import {
  formatDate,
  formatPrice,
  formatTime,
  hasInvoice,
  orderNumber,
  paymentLabel,
  returnStatusLabel,
} from '../format.js';
import { payOrder } from '../razorpay.js';
import { useFetch } from '../useFetch.js';
import NotFound from './NotFound.jsx';
import { StatusBadge } from './Orders.jsx';

// The courier and tracking number of a shipped order, with a link to the courier's tracking page when there is one.
export function ShipmentDetails({ shipment }) {
  return (
    <div className="shipment-details">
      {shipment.courier && (
        <p>
          Shipped with <strong>{shipment.courier}</strong>
          {shipment.trackingNumber && (
            <>
              {' '}
              · Tracking number <strong>{shipment.trackingNumber}</strong>
            </>
          )}
        </p>
      )}
      {shipment.trackingUrl && (
        <a href={shipment.trackingUrl} target="_blank" rel="noopener noreferrer" className="btn small">
          Track your parcel ↗
        </a>
      )}
    </div>
  );
}

export default function Order() {
  const { id } = useParams();
  const { user } = useAuth();
  const location = useLocation();
  const { data, error } = useFetch(user ? `/orders/${encodeURIComponent(id)}` : null);
  // Returns: for delivered orders, what can be returned and what already is.
  const { data: returnInfo } = useFetch(
    data?.status === 'delivered' ? `/orders/${encodeURIComponent(id)}/returns` : null,
  );
  // The order as returned by a cancel or payment, which replaces the loaded one.
  const [updated, setUpdated] = useState(null);
  const [action, setAction] = useState({ busy: false, error: location.state?.paymentError ?? null });

  if (user === undefined) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (error?.status === 404 || error?.status === 400) return <NotFound message="We couldn't find that order." />;
  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const order = updated?.id === data.id ? updated : data;
  const count = order.items.reduce((n, i) => n + i.qty, 0);
  const { address } = order;

  // Runs a change to the order; a returned order replaces the shown one.
  async function run(change) {
    setAction({ busy: true, error: null });
    try {
      const result = await change();
      if (result) setUpdated(result);
      setAction({ busy: false, error: null });
    } catch (err) {
      setAction({ busy: false, error: err.message });
    }
  }

  const paid = order.payment.status === 'paid';
  const cancelOrder = () =>
    window.confirm(paid ? 'Cancel this order? Your payment will be refunded in full.' : 'Cancel this order?') &&
    run(() => request(`/orders/${order.id}/cancel`, { method: 'POST' }));
  // Reopens Razorpay for an order still awaiting payment.
  const payNow = () =>
    run(async () => {
      const reopened = await request(`/orders/${order.id}/pay`, { method: 'POST' });
      return payOrder(reopened, reopened.checkout);
    });
  const checkPayment = () => run(() => request(`/orders/${order.id}/payment/check`, { method: 'POST' }));

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/orders">My orders</Link>
        <span aria-hidden>›</span>
        <span>Order #{orderNumber(order)}</span>
      </nav>

      {location.state?.returnRequested && (
        <p className="notice" role="status">
          Return requested. We&rsquo;ll email you once we&rsquo;ve looked at it.
        </p>
      )}
      {(location.state?.placed || updated) && order.status === 'placed' && (
        <p className="notice" role="status">
          {paid
            ? `Payment received. Thank you! Your order is placed.`
            : `Order placed! Please keep ${formatPrice(order.total)} ready to pay in cash on delivery.`}
        </p>
      )}
      {order.status === 'awaiting_payment' && (
        <div className="notice awaiting" role="status">
          <p>
            Waiting for your payment of {formatPrice(order.total)}. Please pay by {formatTime(order.expiresAt)}, or the
            order will be cancelled and its items released.
          </p>
          <div className="notice-actions">
            <button type="button" className="btn primary small" onClick={payNow} disabled={action.busy}>
              Pay now
            </button>
            <button type="button" className="btn small" onClick={checkPayment} disabled={action.busy}>
              I've paid, check again
            </button>
          </div>
        </div>
      )}

      <div className="cart-page">
        <div className="checkout-main">
          <section className="panel">
            <div className="order-head">
              <div>
                <h1>Order #{orderNumber(order)}</h1>
                <span className="muted small">
                  Ordered on {formatDate(order.createdAt)}
                  {order.shippedAt && ` · shipped on ${formatDate(order.shippedAt)}`}
                  {order.deliveredAt && ` · delivered on ${formatDate(order.deliveredAt)}`}
                  {order.cancelledAt &&
                    (order.cancelledBy === 'system'
                      ? ' · cancelled: payment not completed in time'
                      : ` · cancelled ${order.cancelledBy === 'admin' ? 'by the store ' : ''}on ${formatDate(order.cancelledAt)}`)}
                </span>
              </div>
              <StatusBadge status={order.status} />
            </div>
            <ul className="cart-lines">
              {order.items.map((i) => (
                <li key={lineKey(i)} className="cart-line">
                  <Link to={`/p/${i.slug}`} className="cart-thumb">
                    {i.image && <img src={i.image} alt="" width="96" height="96" />}
                  </Link>
                  <div className="cart-line-body">
                    <span className="brand">{i.brand}</span>
                    <Link to={`/p/${i.slug}`} className="cart-title">
                      {i.title}
                    </Link>
                    <span className="muted small">
                      {formatPrice(i.price)} × {i.qty}
                    </span>
                  </div>
                  <span className="line-total">{formatPrice(i.price * i.qty)}</span>
                </li>
              ))}
            </ul>
          </section>

          {order.shipment && order.status !== 'cancelled' && (
            <section className="panel" aria-labelledby="tracking-heading">
              <h2 id="tracking-heading">Tracking</h2>
              <ShipmentDetails shipment={order.shipment} />
            </section>
          )}

          {returnInfo && (returnInfo.returns.length > 0 || returnInfo.canReturn) && (
            <section className="panel" aria-labelledby="returns-heading">
              <h2 id="returns-heading">Returns</h2>
              {returnInfo.returns.map((r) => (
                <div key={r.id} className="return-row">
                  <p>
                    {r.items.map((i) => `${i.title} × ${i.qty}`).join(', ')}
                    <span className="muted small block">
                      Asked on {formatDate(r.createdAt)} · {r.reasonText} · refund {formatPrice(r.refund)}
                    </span>
                  </p>
                  <span className={`status return-${r.status}`}>{returnStatusLabel(r)}</span>
                  {r.status === 'declined' && r.declineReason && <p className="muted small">Why: {r.declineReason}</p>}
                </div>
              ))}
              {returnInfo.canReturn && returnInfo.items.some((i) => i.returnable > 0) && (
                <p>
                  <Link to={`/orders/${order.id}/return`} className="btn">
                    Return items
                  </Link>{' '}
                  <span className="muted small">until {formatDate(returnInfo.returnableUntil)}</span>
                </p>
              )}
            </section>
          )}

          <section className="panel">
            <h2>Delivery address</h2>
            <address>
              <strong>{address.name}</strong>
              <br />
              {address.line1}
              {address.line2 && (
                <>
                  <br />
                  {address.line2}
                </>
              )}
              <br />
              {address.city}, {address.state} {address.pincode}
              <br />
              Phone {address.phone}
            </address>
          </section>
        </div>

        <OrderSummary
          count={count}
          subtotal={order.subtotal}
          delivery={order.delivery}
          discount={order.discount}
          couponCode={order.coupon?.code}
          total={order.total}
        >
          <p className="muted small">Payment: {paymentLabel(order.payment)}</p>
          {hasInvoice(order) && (
            <Link to={`/orders/${order.id}/invoice`} className="btn">
              Invoice
            </Link>
          )}
          {action.error && (
            <p className="error" role="alert">
              {action.error}
            </p>
          )}
          {(order.status === 'placed' || order.status === 'awaiting_payment') && (
            <button type="button" className="btn" onClick={cancelOrder} disabled={action.busy}>
              Cancel order
            </button>
          )}
        </OrderSummary>
      </div>
    </>
  );
}
