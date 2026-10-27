import { useState } from 'react';
import { lineKey } from '../../cart.js';
import { Link, useParams } from 'react-router';
import { request } from '../../api.js';
import OrderSummary from '../../components/OrderSummary.jsx';
import {
  formatDate,
  formatPrice,
  formatTime,
  hasInvoice,
  orderNumber,
  paymentLabel,
  returnStatusLabel,
} from '../../format.js';
import { useFetch } from '../../useFetch.js';
import NotFound from '../NotFound.jsx';
import { ShipmentDetails } from '../Order.jsx';
import { StatusBadge } from '../Orders.jsx';
import { OrderHelpRequests } from './AdminHelp.jsx';

// The next steps an admin can take from each status (the server enforces the same rules).
const ACTIONS = {
  awaiting_payment: [
    { status: 'cancelled', label: 'Cancel order', confirm: 'Cancel this unpaid order and put the stock back?' },
  ],
  // Shipping is done with the tracking form below.
  placed: [{ status: 'cancelled', label: 'Cancel order', confirm: 'Cancel this order and put the stock back?' }],
  shipped: [
    { status: 'delivered', label: 'Mark as delivered', primary: true },
    { status: 'cancelled', label: 'Cancel order', confirm: 'Cancel this shipped order and put the stock back?' },
  ],
};

// Couriers suggested in the form; any other name can be typed.
const COURIERS = ['India Post', 'Delhivery', 'Blue Dart', 'DTDC', 'Ekart', 'Xpressbees', 'Shadowfax', 'Ecom Express'];

// The courier, tracking number and tracking link: filled in when marking a placed order shipped (`onSubmit` ships
// it), or edited later. All optional.
function ShipmentForm({ shipment, submitLabel, busy, onSubmit, onCancel }) {
  function submit(e) {
    e.preventDefault();
    onSubmit(Object.fromEntries(new FormData(e.currentTarget)));
  }
  return (
    <form className="shipment-form" onSubmit={submit} aria-label="Tracking">
      <label>
        Courier
        <input name="courier" list="couriers" maxLength={40} defaultValue={shipment?.courier} />
      </label>
      <datalist id="couriers">
        {COURIERS.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <label>
        Tracking number
        <input name="trackingNumber" maxLength={40} defaultValue={shipment?.trackingNumber} />
      </label>
      <label>
        Tracking link (optional)
        <input
          name="trackingUrl"
          type="url"
          maxLength={500}
          placeholder="https://…"
          defaultValue={shipment?.trackingUrl}
        />
        <span className="muted small">
          Paste it from the courier&rsquo;s site; customers get a &ldquo;Track your parcel&rdquo; link.
        </span>
      </label>
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

// Admins' private notes: customers never see them. A note can also go on the packing slip ("deliver after 6 pm").
function OrderNotes({ order, onChange, busy }) {
  function add(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    onChange(() =>
      request(`/admin/orders/${order.id}/notes`, {
        method: 'POST',
        body: { text: data.get('text'), onSlip: data.get('onSlip') === 'on' },
      }),
    ).then((ok) => ok && form.reset());
  }
  function remove(note) {
    if (!window.confirm('Delete this note?')) return;
    onChange(() => request(`/admin/orders/${order.id}/notes/${note.id}`, { method: 'DELETE' }));
  }
  return (
    <section className="panel order-notes" aria-labelledby="order-notes">
      <h2 id="order-notes">Private notes</h2>
      <p className="muted small">Only admins see these.</p>
      {order.notes.length > 0 && (
        <ul className="note-list">
          {order.notes.map((n) => (
            <li key={n.id}>
              <p className="review-body">{n.text}</p>
              <span className="muted small">
                {n.by?.name ?? 'An admin'} · {formatDate(n.at)}, {formatTime(n.at)}
                {n.onSlip && ' · on the packing slip'}
                {' · '}
                <button type="button" className="link" onClick={() => remove(n)} disabled={busy}>
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form className="review-form" onSubmit={add}>
        <label>
          Add a note
          <textarea name="text" rows={2} maxLength={1000} required />
        </label>
        <label className="check">
          <input type="checkbox" name="onSlip" />
          Also print on the packing slip
        </label>
        <div className="form-actions">
          <button type="submit" className="btn small" disabled={busy}>
            Add note
          </button>
        </div>
      </form>
    </section>
  );
}

export default function AdminOrder() {
  const { id } = useParams();
  const { data, error } = useFetch(`/admin/orders/${encodeURIComponent(id)}`);
  const { data: returns } = useFetch(`/admin/orders/${encodeURIComponent(id)}/returns`);
  const [updated, setUpdated] = useState(null);
  const [action, setAction] = useState({ busy: false, error: null });
  const [editingShipment, setEditingShipment] = useState(false);

  if (error?.status === 404 || error?.status === 400) return <NotFound message="We couldn't find that order." />;
  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const order = updated?.id === data.id ? updated : data;
  const { address, customer } = order;

  // Returns whether it worked (the notes form clears itself then).
  async function run(change) {
    setAction({ busy: true, error: null });
    try {
      setUpdated(await change());
      setAction({ busy: false, error: null });
      return true;
    } catch (err) {
      setAction({ busy: false, error: err.message });
      return false;
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
  const shipOrder = (shipment) =>
    run(() => request(`/admin/orders/${order.id}/status`, { method: 'POST', body: { status: 'shipped', shipment } }));
  const saveShipment = (shipment) =>
    run(async () => {
      const saved = await request(`/admin/orders/${order.id}/shipment`, { method: 'PUT', body: shipment });
      setEditingShipment(false);
      return saved;
    });

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
            <OrderHelpRequests orderId={order.id} />
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

          {returns?.length > 0 && (
            <section className="panel" aria-labelledby="order-returns">
              <h2 id="order-returns">Returns</h2>
              {returns.map((r) => (
                <div key={r.id} className="return-row">
                  <p>
                    {r.items.map((i) => `${i.title} × ${i.qty}`).join(', ')}
                    <span className="muted small block">
                      {formatDate(r.createdAt)} · {r.reasonText} · refund {formatPrice(r.refund)}
                    </span>
                  </p>
                  <span className={`status return-${r.status}`}>{returnStatusLabel(r, { admin: true })}</span>
                  {r.creditNote && (
                    <Link to={`/admin/orders/${order.id}/credit-notes/${r.id}`} className="small">
                      Credit note {r.creditNote.number}
                    </Link>
                  )}
                </div>
              ))}
              <Link to={`/admin/returns${returns.some((r) => r.status === 'requested') ? '' : '?status=all'}`}>
                Manage returns
              </Link>
            </section>
          )}

          <OrderNotes order={order} onChange={run} busy={action.busy} />

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
          {order.status === 'placed' && (
            <ShipmentForm submitLabel="Mark as shipped" busy={action.busy} onSubmit={shipOrder} />
          )}
          {(order.status === 'shipped' || order.status === 'delivered') &&
            (editingShipment ? (
              <ShipmentForm
                shipment={order.shipment}
                submitLabel="Save tracking"
                busy={action.busy}
                onSubmit={saveShipment}
                onCancel={() => setEditingShipment(false)}
              />
            ) : (
              <div className="shipment-info small">
                {order.shipment ? (
                  <ShipmentDetails shipment={order.shipment} />
                ) : (
                  <p className="muted">No tracking added.</p>
                )}
                <button type="button" className="link" onClick={() => setEditingShipment(true)}>
                  {order.shipment ? 'Edit tracking' : 'Add tracking'}
                </button>
              </div>
            ))}
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
