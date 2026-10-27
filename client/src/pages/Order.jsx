import { useState } from 'react';
import { addLines, cartQuery, lineKey } from '../cart.js';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router';
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
  smallImage,
} from '../format.js';
import { payOrder } from '../razorpay.js';
import { useFetch } from '../useFetch.js';
import NotFound from './NotFound.jsx';
import { StatusBadge } from './Orders.jsx';

// Why a past order's line can't go back in the cart, from its cart quote (GET /cart); null when it can.
function notAddable(line) {
  if (!line.product || line.problem === 'No longer available') return 'no longer sold';
  if (line.problem === 'Out of stock') return 'out of stock';
  // A product that has sizes or colours since it was bought: the quote asks to choose one.
  if (!line.stock) return line.problem.toLowerCase();
  return null;
}

// Puts the order's items that can still be bought back in the cart, as many as were bought (or as are left), at
// today's prices. Returns { added, skipped: [{ title, reason }] }.
async function buyAgain(order) {
  const quote = await request(`/cart?items=${cartQuery(order.items)}`);
  const titleOf = new Map(order.items.map((i) => [lineKey(i), i.title]));
  const lines = [];
  const skipped = [];
  for (const line of quote.items) {
    const reason = notAddable(line);
    if (reason) skipped.push({ title: titleOf.get(lineKey(line)), reason });
    else {
      const { productId, variantId } = line;
      lines.push({ productId, ...(variantId && { variantId }), qty: Math.min(line.qty, line.stock) });
    }
  }
  const full = lines.length ? addLines(lines) : [];
  skipped.push(...full.map((l) => ({ title: titleOf.get(lineKey(l)), reason: 'your cart is full' })));
  return { added: lines.length - full.length, skipped };
}

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
  const navigate = useNavigate();
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
  const reorder = () =>
    run(async () => {
      const result = await buyAgain(order);
      if (!result.added) {
        throw new Error(
          `None of these items can be added now: ${result.skipped.map((s) => `${s.title} (${s.reason})`).join(', ')}.`,
        );
      }
      navigate('/cart', { state: { boughtAgain: { number: orderNumber(order), ...result } } });
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
                  {/* The picture repeats the name's link next to it: a shortcut for the mouse, skipped by keyboards and screen readers. */}
                  <Link to={`/p/${i.slug}`} className="cart-thumb" tabIndex={-1} aria-hidden="true">
                    {i.image && <img src={smallImage(i.image)} alt="" width="96" height="96" />}
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
                  {r.creditNote && (
                    <Link to={`/orders/${order.id}/credit-notes/${r.id}`} className="small">
                      Credit note {r.creditNote.number}
                    </Link>
                  )}
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
          {order.status !== 'awaiting_payment' && (
            <button type="button" className="btn" onClick={reorder} disabled={action.busy}>
              Buy again
            </button>
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
          <Link to={`/help?order=${order.id}`} className="btn">
            Get help with this order
          </Link>
        </OrderSummary>
      </div>
    </>
  );
}
