import { Link, Navigate, useLocation, useParams } from 'react-router';
import { lineKey } from '../cart.js';
import { useAuth } from '../auth.jsx';
import { formatAmount, formatDate, formatPrice, hasInvoice, orderNumber } from '../format.js';
import { useFetch } from '../useFetch.js';
import NotFound from './NotFound.jsx';

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

const percent = (rate) => `${rate}%`;

// The lines of a tax invoice (orders placed with GST on): each line's taxable value and tax, then the tax by rate.
// Prices include GST, so the lines add up to the order's total; a coupon is already taken off the lines.
function GstLines({ order }) {
  const inv = order.gstInvoice;
  const taxes = inv.intraState
    ? [
        ['cgst', 'CGST'],
        ['sgst', 'SGST'],
      ]
    : [['igst', 'IGST']];
  return (
    <>
      <div className="table-wrap">
        <table className="invoice-table gst-lines">
          <thead>
            <tr>
              <th>Item</th>
              <th className="gst-wide">HSN</th>
              <th className="num gst-wide">Qty</th>
              <th className="num">Taxable value</th>
              <th className="num gst-wide">GST</th>
              <th className="num">Tax</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l, i) => (
              <tr key={i}>
                <td>
                  {l.title}
                  {/* On phones the narrow columns are hidden and shown here instead. */}
                  <span className="gst-narrow muted small block">
                    {[l.hsn && `HSN ${l.hsn}`, `GST ${percent(l.rate)}`, `Qty ${l.qty}`].filter(Boolean).join(' · ')}
                  </span>
                </td>
                <td className="gst-wide">{l.hsn}</td>
                <td className="num gst-wide">{l.qty}</td>
                <td className="num">{formatAmount(l.taxable)}</td>
                <td className="num gst-wide">{percent(l.rate)}</td>
                <td className="num">{formatAmount(l.tax)}</td>
                <td className="num">{formatAmount(l.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <table className="invoice-table invoice-sums" aria-label="Totals">
        <tbody>
          <tr>
            <th>Taxable value</th>
            <td className="num">{formatAmount(inv.totals.taxable)}</td>
          </tr>
          {taxes.map(([key, label]) => (
            <tr key={key}>
              <th>{label}</th>
              <td className="num">{formatAmount(inv.totals[key])}</td>
            </tr>
          ))}
          <tr className="invoice-total">
            <th>Total</th>
            <td className="num">{formatAmount(order.total)}</td>
          </tr>
        </tbody>
      </table>
      {order.discount > 0 && (
        <p className="muted small">
          Coupon{order.coupon?.code && ` ${order.coupon.code}`}: {formatAmount(order.discount)} off, already taken off
          the amounts above.
        </p>
      )}
      <div className="table-wrap">
        <table className="invoice-table invoice-tax-summary" aria-label="Tax by rate">
          <thead>
            <tr>
              <th>GST rate</th>
              <th className="num">Taxable value</th>
              {taxes.map(([key, label]) => (
                <th key={key} className="num">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {inv.byRate.map((r) => (
              <tr key={r.rate}>
                <td>{percent(r.rate)}</td>
                <td className="num">{formatAmount(r.taxable)}</td>
                {taxes.map(([key]) => (
                  <td key={key} className="num">
                    {formatAmount(r[key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
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
  const gst = order.gstInvoice;

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
            <h1 id="invoice-heading">{gst ? 'Tax invoice' : 'Invoice'}</h1>
            <dl>
              <dt>{gst ? 'Invoice no.' : 'Order'}</dt>
              <dd>#{orderNumber(order)}</dd>
              <dt>Date</dt>
              <dd>{formatDate(order.createdAt)}</dd>
            </dl>
          </div>
        </header>

        <div className="invoice-parties-row">
          {gst && (
            <section className="invoice-parties" aria-label="Sold by">
              <h2>Sold by</h2>
              <address>
                <strong>{gst.seller.legalName}</strong>
                <br />
                <span className="pre-line">{gst.seller.address}</span>
                <br />
                {gst.seller.state}
                <br />
                GSTIN {gst.seller.gstin}
              </address>
            </section>
          )}
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
            {gst && (
              <p className="small">
                Place of supply: {gst.placeOfSupply.name}
                {gst.placeOfSupply.code && ` (${gst.placeOfSupply.code})`}
              </p>
            )}
          </section>
        </div>

        {gst ? (
          <GstLines order={order} />
        ) : (
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
                <tr key={lineKey(i)}>
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
        )}

        <p>
          <strong>Payment:</strong> {paymentLine(order)}
        </p>
        <p className="muted small">
          {gst ? `Prices include GST of ${formatAmount(gst.totals.tax)}.` : 'Prices include all charges.'}
        </p>
      </article>
    </div>
  );
}
