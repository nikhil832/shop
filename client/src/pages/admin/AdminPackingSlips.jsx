import { Link, useSearchParams } from 'react-router';
import { itemKey } from '../../cart.js';
import { formatDate, formatPrice, orderNumber } from '../../format.js';
import { useFetch } from '../../useFetch.js';
import { StatusBadge } from '../Orders.jsx';

// What the packer needs to know about payment: how much to collect for Cash on Delivery.
function paymentNote(order) {
  if (order.payment.method === 'razorpay') return 'Paid online: nothing to collect.';
  if (order.payment.method === 'credit') return 'Paid with store credit: nothing to collect.';
  return `Cash on Delivery: collect ${formatPrice(order.total - order.creditUsed)}.`;
}

// One packing slip per order (/admin/orders/slips?ids=…, from the orders list): where it goes and what goes in the box,
// with no prices (fine for gifts). Each prints on its own page.
export default function AdminPackingSlips() {
  const [params] = useSearchParams();
  const ids = params.get('ids') ?? '';
  const { data, error } = useFetch(ids ? `/admin/orders?ids=${encodeURIComponent(ids)}` : null);
  const orders = data?.items ?? [];

  return (
    <div className="slips-page">
      <div className="invoice-actions no-print">
        <Link to="/admin/orders">← Back to orders</Link>
        {orders.length > 0 && (
          <button type="button" className="btn primary" onClick={() => window.print()}>
            Print {orders.length} {orders.length === 1 ? 'slip' : 'slips'}
          </button>
        )}
      </div>
      {!ids && <p className="muted">Choose orders on the Orders page, then “Print packing slips”.</p>}
      {error && <p className="error">{error.message}</p>}
      {ids && !data && !error && <p className="muted">Loading…</p>}
      {orders.map((order) => {
        const a = order.address;
        return (
          <article key={order.id} className="panel slip" aria-label={`Packing slip for order #${orderNumber(order)}`}>
            <header className="invoice-head">
              <div>
                <p className="invoice-brand">Bazaar</p>
                <p className="muted small">Packing slip</p>
              </div>
              <div className="invoice-meta">
                <h1>Order #{orderNumber(order)}</h1>
                <p className="small">
                  Ordered {formatDate(order.createdAt)}
                  {order.status !== 'placed' && (
                    <>
                      {' '}
                      · <StatusBadge status={order.status} />
                    </>
                  )}
                </p>
              </div>
            </header>
            <section className="invoice-parties" aria-label="Ship to">
              <h2>Ship to</h2>
              <address className="slip-address">
                <strong>{a.name}</strong>
                <br />
                {a.line1}
                {a.line2 && (
                  <>
                    <br />
                    {a.line2}
                  </>
                )}
                <br />
                {a.city}, {a.state} {a.pincode}
                <br />
                Phone {a.phone}
              </address>
            </section>
            <table className="invoice-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Qty</th>
                  <th className="num">Packed</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((i) => (
                  <tr key={itemKey(i)}>
                    <td>
                      {i.title}
                      {i.brand && <span className="muted small"> · {i.brand}</span>}
                    </td>
                    <td className="num slip-qty">{i.qty}</td>
                    <td className="num">
                      <span className="slip-box" aria-hidden />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {order.notes
              .filter((n) => n.onSlip)
              .map((n) => (
                <p key={n.id} className="slip-note">
                  <strong>Note:</strong> {n.text}
                </p>
              ))}
            <p className="slip-payment">{paymentNote(order)}</p>
          </article>
        );
      })}
    </div>
  );
}
