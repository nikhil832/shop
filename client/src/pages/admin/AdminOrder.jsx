import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { request } from '../../api.js';
import OrderSummary from '../../components/OrderSummary.jsx';
import { formatDate, formatPrice, orderNumber } from '../../format.js';
import { useFetch } from '../../useFetch.js';
import NotFound from '../NotFound.jsx';
import { StatusBadge } from '../Orders.jsx';

// The next steps an admin can take from each status (the server enforces the same rules).
const ACTIONS = {
  placed: [
    { status: 'shipped', label: 'Mark as shipped', primary: true },
    { status: 'cancelled', label: 'Cancel order', confirm: 'Cancel this order and put the stock back?' },
  ],
  shipped: [
    { status: 'delivered', label: 'Mark as delivered', primary: true },
    { status: 'cancelled', label: 'Cancel order', confirm: 'Cancel this shipped order and put the stock back?' },
  ],
};

export default function AdminOrder() {
  const { id } = useParams();
  const { data, error } = useFetch(`/admin/orders/${encodeURIComponent(id)}`);
  const [updated, setUpdated] = useState(null);
  const [action, setAction] = useState({ busy: false, error: null });

  if (error?.status === 404 || error?.status === 400) return <NotFound message="We couldn't find that order." />;
  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const order = updated?.id === data.id ? updated : data;
  const { address, customer } = order;

  async function setStatus({ status, confirm }) {
    if (confirm && !window.confirm(confirm)) return;
    setAction({ busy: true, error: null });
    try {
      setUpdated(await request(`/admin/orders/${order.id}/status`, { method: 'POST', body: { status } }));
      setAction({ busy: false, error: null });
    } catch (err) {
      setAction({ busy: false, error: err.message });
    }
  }

  const timeline = [
    ['Placed', order.createdAt],
    ['Shipped', order.shippedAt],
    ['Delivered', order.deliveredAt],
    [order.cancelledBy === 'customer' ? 'Cancelled by customer' : 'Cancelled', order.cancelledAt],
  ].filter(([, at]) => at);

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/admin/orders">Orders</Link>
        <span aria-hidden>›</span>
        <span>#{orderNumber(order)}</span>
      </nav>
      <div className="cart-page">
        <div className="checkout-main">
          <section className="panel">
            <div className="order-head">
              <h1>Order #{orderNumber(order)}</h1>
              <StatusBadge status={order.status} />
            </div>
            <ol className="timeline">
              {timeline.map(([label, at]) => (
                <li key={label}>
                  <strong>{label}</strong> <span className="muted">{formatDate(at)}</span>
                </li>
              ))}
            </ol>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Price</th>
                  <th className="num">Qty</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((i) => (
                  <tr key={i.productId}>
                    <td>
                      <Link to={`/admin/products/${i.productId}`}>{i.title}</Link>
                    </td>
                    <td className="num">{formatPrice(i.price)}</td>
                    <td className="num">{i.qty}</td>
                    <td className="num">{formatPrice(i.price * i.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="panel admin-columns">
            <div>
              <h2>Customer</h2>
              <p>
                {customer?.name ?? 'Deleted account'}
                <br />
                <span className="muted">{customer?.email}</span>
              </p>
            </div>
            <div>
              <h2>Deliver to</h2>
              <address>
                {address.name}, {address.phone}
                <br />
                {address.line1}
                {address.line2 && `, ${address.line2}`}
                <br />
                {address.city}, {address.state} {address.pincode}
              </address>
            </div>
          </section>
        </div>

        <OrderSummary
          count={order.items.reduce((n, i) => n + i.qty, 0)}
          subtotal={order.subtotal}
          delivery={order.delivery}
          total={order.total}
        >
          <p className="muted small">Payment: Cash on Delivery</p>
          {action.error && (
            <p className="error" role="alert">
              {action.error}
            </p>
          )}
          {ACTIONS[order.status]?.map((a) => (
            <button
              key={a.status}
              type="button"
              className={`btn ${a.primary ? 'primary' : ''}`}
              disabled={action.busy}
              onClick={() => setStatus(a)}
            >
              {a.label}
            </button>
          ))}
        </OrderSummary>
      </div>
    </>
  );
}
