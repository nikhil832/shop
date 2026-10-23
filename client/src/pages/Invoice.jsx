import { Link, Navigate, useLocation, useParams } from 'react-router';
import { useAuth } from '../auth.jsx';
import { formatDate, formatPrice, orderNumber } from '../format.js';
import { useFetch } from '../useFetch.js';
import NotFound from './NotFound.jsx';

// Orders that have an invoice: placed and not cancelled. Unpaid online orders aren't sales yet.
export const hasInvoice = (order) => ['placed', 'shipped', 'delivered'].includes(order.status);

// How the order is paid, as of now.
function paymentLine(order) {
  const { payment } = order;
  if (payment.method === 'razorpay') {
    return `Paid online${payment.paidAt ? ` on ${formatDate(payment.paidAt)}` : ''}`;
  }
  return order.deliveredAt
    ? `Cash on Delivery, paid on ${formatDate(order.deliveredAt)}`
    : `Cash on Delivery: ${formatPrice(order.total)} to pay on delivery`;
}

// A printable bill for one order, for its customer (/orders/:id/invoice) or an admin (/admin/orders/:id/invoice).
// Printing hides the store's header and buttons; the browser's print dialog can save it as a PDF.
export default function Invoice({ admin = false }) {
  const { id } = useParams();
  const { user } = useAuth();
  const location = useLocation();
  const path = `${admin ? '/admin' : ''}/orders/${encodeURIComponent(id)}`;
  // The admin layout already checks the login; the customer page waits for it.
  const { data: order, error } = useFetch(admin || user ? path : null);

  if (!admin && user === undefined) return <p className="muted">Loading…</p>;
  if (!admin && !user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (error?.status === 404 || error?.status === 400) return <NotFound message="We couldn't find that order." />;
  if (error) return <p className="error">{error.message}</p>;
  if (!order) return <p className="muted">Loading…</p>;

  const back = (
    <Link to={path} className="no-print">
      ← Back to order #{orderNumber(order)}
    </Link>
  );
  if (!hasInvoice(order)) {
    return (
      <div className="panel invoice-missing">
        <h1>No invoice for this order</h1>
        <p>
          {order.status === 'cancelled'
            ? 'This order was cancelled, so there is nothing to bill.'
            : 'An invoice is ready once the order is paid.'}
        </p>
        {back}
      </div>
    );
  }

  const { address } = order;
  const email = admin ? order.customer?.email : user.email;

  return (
    <div className="invoice-page">
      <div className="invoice-actions no-print">
        {back}
        <button type="button" className="btn primary" onClick={() => window.print()}>
          Print or save as PDF
        </button>
      </div>

      <article className="panel invoice" aria-labelledby="invoice-heading">
        <header className="invoice-head">
          <div>
            <p className="invoice-brand">Bazaar</p>
            <p className="muted small">A demo store: nothing here is really sold or delivered.</p>
          </div>
          <div className="invoice-meta">
            <h1 id="invoice-heading">Invoice</h1>
            <dl>
              <dt>Order</dt>
              <dd>#{orderNumber(order)}</dd>
              <dt>Date</dt>
              <dd>{formatDate(order.createdAt)}</dd>
            </dl>
          </div>
        </header>

        <section className="invoice-parties" aria-label="Billed to">
          <h2>Billed to</h2>
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
            {email && (
              <>
                <br />
                {email}
              </>
            )}
          </address>
        </section>

        <table className="invoice-table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Price</th>
              <th className="num">Qty</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((i) => (
              <tr key={i.productId}>
                <td>
                  {i.title}
                  {i.brand && <span className="muted small"> · {i.brand}</span>}
                </td>
                <td className="num">{formatPrice(i.price)}</td>
                <td className="num">{i.qty}</td>
                <td className="num">{formatPrice(i.price * i.qty)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={3}>Items</th>
              <td className="num">{formatPrice(order.subtotal)}</td>
            </tr>
            <tr>
              <th colSpan={3}>Delivery</th>
              <td className="num">{order.delivery ? formatPrice(order.delivery) : 'Free'}</td>
            </tr>
            {order.discount > 0 && (
              <tr>
                <th colSpan={3}>Coupon{order.coupon?.code && ` (${order.coupon.code})`}</th>
                <td className="num">−{formatPrice(order.discount)}</td>
              </tr>
            )}
            <tr className="invoice-total">
              <th colSpan={3}>Total</th>
              <td className="num">{formatPrice(order.total)}</td>
            </tr>
          </tfoot>
        </table>

        <p>
          <strong>Payment:</strong> {paymentLine(order)}
        </p>
        <p className="muted small">Prices include all charges.</p>
      </article>
    </div>
  );
}
