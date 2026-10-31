import { Link, useSearchParams } from 'react-router';
import { formatPrice, orderNumber } from '../../format.js';
import { useFetch } from '../../useFetch.js';

// The two ways labels print: four to an A4 sheet (cut along the lines), or one per page for 4 × 6 inch label printers.
const LAYOUTS = {
  sheet: { name: 'Four to an A4 sheet', per: 4 },
  roll: { name: 'One per page (4 × 6 inch label printer)', per: 1 },
};

const unitsOf = (order) => order.items.reduce((n, i) => n + i.qty, 0);

// Splits the labels into printed pages.
function pagesOf(orders, per) {
  const pages = [];
  for (let i = 0; i < orders.length; i += per) pages.push(orders.slice(i, i + per));
  return pages;
}

// A line to write on, read out as "not set yet".
const Blank = () => (
  <span className="label-blank">
    <span className="sr-only">not set yet</span>
  </span>
);

function Label({ order }) {
  const a = order.address;
  const due = order.total - order.creditUsed;
  const cod = order.payment.method === 'cod' && due > 0;
  // With GST on, the order keeps the store's legal name and address: the return address.
  const seller = order.gstInvoice?.seller;
  return (
    <article className="label" aria-label={`Shipping label for order #${orderNumber(order)}`}>
      <p className="label-number">#{orderNumber(order)}</p>
      <div className="label-to">
        <span className="label-tag">To</span>
        <address>
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
          {a.city}, {a.state}
          <br />
          <span className="label-pin">PIN {a.pincode}</span>
          <br />
          Phone {a.phone}
        </address>
      </div>
      <p className={`label-payment ${cod ? 'cod' : ''}`}>
        {cod ? `Cash on Delivery: collect ${formatPrice(due)}` : 'Prepaid: nothing to collect'}
      </p>
      <dl className="label-details">
        <div>
          <dt>Courier</dt>
          <dd>{order.shipment?.courier || <Blank />}</dd>
        </div>
        <div>
          <dt>Tracking no.</dt>
          <dd>{order.shipment?.trackingNumber || <Blank />}</dd>
        </div>
        <div>
          <dt>Items</dt>
          <dd>{unitsOf(order)}</dd>
        </div>
      </dl>
      <div className="label-from">
        <span className="label-tag">From</span>
        {seller ? (
          <span>
            {seller.legalName}, <span className="pre-line">{seller.address}</span>, {seller.state}
          </span>
        ) : (
          <span>Bazaar</span>
        )}
      </div>
    </article>
  );
}

// Shipping labels for the orders chosen on the Orders page (/admin/orders/labels?ids=…&layout=sheet|roll), beside
// the packing slips: the order number large, the address, what to collect and the courier (blank lines to write on
// when it isn't set yet).
export default function AdminShippingLabels() {
  const [params, setParams] = useSearchParams();
  const ids = params.get('ids') ?? '';
  const layout = LAYOUTS[params.get('layout')] ? params.get('layout') : 'sheet';
  const { data, error } = useFetch(ids ? `/admin/orders?ids=${encodeURIComponent(ids)}` : null);
  const orders = data?.items ?? [];

  function chooseLayout(e) {
    const next = new URLSearchParams(params);
    next.set('layout', e.target.value);
    setParams(next, { replace: true });
  }

  return (
    <div className={`labels-page ${layout}`}>
      <div className="invoice-actions no-print">
        <Link to="/admin/orders">← Back to orders</Link>
        {ids && <Link to={`/admin/orders/slips?ids=${ids}`}>Packing slips</Link>}
        <label className="labels-layout">
          Print
          <select value={layout} onChange={chooseLayout}>
            {Object.entries(LAYOUTS).map(([value, l]) => (
              <option key={value} value={value}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        {orders.length > 0 && (
          <button type="button" className="btn primary" onClick={() => window.print()}>
            Print {orders.length} {orders.length === 1 ? 'label' : 'labels'}
          </button>
        )}
      </div>
      {!ids && <p className="muted">Choose orders on the Orders page, then “Print shipping labels”.</p>}
      {error && <p className="error">{error.message}</p>}
      {ids && !data && !error && <p className="muted">Loading…</p>}
      {pagesOf(orders, LAYOUTS[layout].per).map((page) => (
        <div key={page[0].id} className="label-sheet">
          {page.map((order) => (
            <Label key={order.id} order={order} />
          ))}
        </div>
      ))}
    </div>
  );
}
