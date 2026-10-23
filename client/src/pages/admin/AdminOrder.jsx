import { useState } from 'react';
import { lineKey } from '../../cart.js';
import { Link, useParams } from 'react-router';
import { request } from '../../api.js';
import OrderSummary from '../../components/OrderSummary.jsx';
import { formatDate, formatPrice, orderNumber, paymentLabel } from '../../format.js';
import { useFetch } from '../../useFetch.js';
import { hasInvoice } from '../Invoice.jsx';
import NotFound from '../NotFound.jsx';
import { StatusBadge } from '../Orders.jsx';

// The next steps an admin can take from each status (the server enforces the same rules).
const ACTIONS = {
  awaiting_payment: [
    { status: 'cancelled', label: 'Cancel order', confirm: 'Cancel this unpaid order and put the stock back?' },
  ],
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

  async function run(change) {
    setAction({ busy: true, error: null });
    try {
      setUpdated(await change());
      setAction({ busy: false, error: null });
    } catch (err) {
      setAction({ busy: false, error: err.message });
    }
  }

  const { payment } = order;
  // Cancelling a paid order refunds it, so say so in the confirmation.
  const setStatus = ({ status, confirm }) => {
    const text =
      confirm && payment.status === 'paid' ? confirm.replace('?', ' and refund the payment in full?') : confirm;
    if (text && !window.confirm(text)) return;
    run(() => request(`/admin/orders/${order.id}/status`, { method: 'POST', body: { status } }));
  };
  const retryRefund = () => run(() => request(`/admin/orders/${order.id}/refund`, { method: 'POST' }));

  const timeline = [
    ['Ordered', order.createdAt],
    [payment.paidAt && 'Paid', payment.paidAt],
    ['Shipped', order.shippedAt],
    ['Delivered', order.deliveredAt],
    [
      { customer: 'Cancelled by customer', system: 'Expired unpaid' }[order.cancelledBy] ?? 'Cancelled',
      order.cancelledAt,
    ],
    [payment.refundedAt && 'Refund started', payment.refundedAt],
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
                  <tr key={lineKey(i)}>
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
          discount={order.discount}
          couponCode={order.coupon?.code}
          total={order.total}
        >
          <div className="muted small payment-info">
            <p>Payment: {paymentLabel(payment, { admin: true })}</p>
            {payment.razorpayPaymentId && <p>Razorpay payment {payment.razorpayPaymentId}</p>}
            {payment.refundId && <p>Refund {payment.refundId}</p>}
            {payment.refundError && <p className="error">Refund error: {payment.refundError}</p>}
          </div>
          {hasInvoice(order) && (
            <Link to={`/admin/orders/${order.id}/invoice`} className="btn">
              Invoice
            </Link>
          )}
          {payment.status === 'refund_failed' && (
            <button type="button" className="btn primary" onClick={retryRefund} disabled={action.busy}>
              Retry refund
            </button>
          )}
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
