import { useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';
import OrderSummary from '../components/OrderSummary.jsx';
import { formatDate, formatPrice, orderNumber } from '../format.js';
import { useFetch } from '../useFetch.js';
import NotFound from './NotFound.jsx';
import { StatusBadge } from './Orders.jsx';

export default function Order() {
  const { id } = useParams();
  const { user } = useAuth();
  const location = useLocation();
  const { data, error } = useFetch(user ? `/orders/${encodeURIComponent(id)}` : null);
  // The order as returned by a cancel, which replaces the loaded one.
  const [updated, setUpdated] = useState(null);
  const [cancel, setCancel] = useState({ busy: false, error: null });

  if (user === undefined) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (error?.status === 404 || error?.status === 400) return <NotFound message="We couldn't find that order." />;
  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const order = updated?.id === data.id ? updated : data;
  const count = order.items.reduce((n, i) => n + i.qty, 0);
  const { address } = order;

  async function cancelOrder() {
    if (!window.confirm('Cancel this order?')) return;
    setCancel({ busy: true, error: null });
    try {
      setUpdated(await request(`/orders/${order.id}/cancel`, { method: 'POST' }));
      setCancel({ busy: false, error: null });
    } catch (err) {
      setCancel({ busy: false, error: err.message });
    }
  }

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/orders">My orders</Link>
        <span aria-hidden>›</span>
        <span>Order #{orderNumber(order.id)}</span>
      </nav>

      {location.state?.placed && order.status === 'placed' && (
        <p className="notice" role="status">
          Order placed! Please keep {formatPrice(order.total)} ready to pay in cash on delivery.
        </p>
      )}

      <div className="cart-page">
        <div className="checkout-main">
          <section className="panel">
            <div className="order-head">
              <div>
                <h1>Order #{orderNumber(order.id)}</h1>
                <span className="muted small">
                  Placed on {formatDate(order.createdAt)}
                  {order.cancelledAt && ` · cancelled on ${formatDate(order.cancelledAt)}`}
                </span>
              </div>
              <StatusBadge status={order.status} />
            </div>
            <ul className="cart-lines">
              {order.items.map((i) => (
                <li key={i.productId} className="cart-line">
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

        <OrderSummary count={count} subtotal={order.subtotal} delivery={order.delivery} total={order.total}>
          <p className="muted small">Payment: Cash on Delivery</p>
          {cancel.error && (
            <p className="error" role="alert">
              {cancel.error}
            </p>
          )}
          {order.status === 'placed' && (
            <button type="button" className="btn" onClick={cancelOrder} disabled={cancel.busy}>
              Cancel order
            </button>
          )}
        </OrderSummary>
      </div>
    </>
  );
}
