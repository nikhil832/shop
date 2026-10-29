import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { query, request } from '../../api.js';
import Pager from '../../components/Pager.jsx';
import { formatDate, formatPrice, toPaise, toRupees } from '../../format.js';
import { useFetch } from '../../useFetch.js';
import NotFound from '../NotFound.jsx';
import { ProductSearch } from './AdminReceipts.jsx';

// Supplier orders (stage 93): what the store asks suppliers for, printed and sent by the admin, then received against
// under Receiving, which counts what came towards each line.

const STATUS = { open: 'Open', received: 'Received', closed: 'Closed short', cancelled: 'Cancelled' };
const FILTERS = [
  ['open', 'Open'],
  ['received', 'Received'],
  ['closed', 'Closed short'],
  ['cancelled', 'Cancelled'],
  ['', 'All'],
];
// 'YYYY-MM-DD' as "20 Nov 2026".
const day = (iso) => formatDate(`${iso}T00:00:00`);

// /admin/purchase-orders: open ones first by default.
export function AdminPurchaseOrders() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('status') ?? 'open';
  const status = raw === 'all' ? '' : raw;
  const page = Math.max(1, Number(params.get('page')) || 1);
  const { data, error, loading } = useFetch(`/admin/purchase-orders${query({ status, page: page > 1 ? page : '' })}`);
  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Supplier orders</h1>
        <Link to="/admin/purchase-orders/new" className="btn primary">
          New supplier order
        </Link>
      </div>
      <p className="muted small">
        Print an order (or save it as a PDF) to send to the supplier. When the goods come, record the delivery from the
        order: what arrived is counted against it. What open orders will bring is taken off the dashboard&apos;s reorder
        suggestions.
      </p>
      <div className="status-tabs" role="group" aria-label="Filter by status">
        {FILTERS.map(([s, label]) => (
          <button
            key={s}
            type="button"
            className={s === status ? 'active' : ''}
            aria-pressed={s === status}
            onClick={() => setParams(s === 'open' ? {} : { status: s || 'all' })}
          >
            {label}
            {data && s && <span className="count">{data.counts[s]}</span>}
          </button>
        ))}
      </div>
      {error && <p className="error">{error.message}</p>}
      {data?.items.length === 0 && <p className="muted">No supplier orders here.</p>}
      {data?.items.length > 0 && (
        <div className="table-wrap">
          <table className={`admin-table ${loading ? 'stale' : ''}`}>
            <thead>
              <tr>
                <th>Order</th>
                <th>Supplier</th>
                <th className="num">Received</th>
                <th className="num">Value</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link to={`/admin/purchase-orders/${o.id}`}>#{o.number}</Link>
                    <span className="muted small block">
                      {formatDate(o.createdAt)}
                      {o.expectedOn && ` · expected ${day(o.expectedOn)}`}
                    </span>
                  </td>
                  <td>{o.supplier}</td>
                  <td className="num">
                    {o.received} of {o.units}
                  </td>
                  <td className="num">{o.value === null ? '—' : formatPrice(o.value)}</td>
                  <td>{STATUS[o.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && (
        <Pager
          page={page}
          total={data.total}
          pageSize={data.pageSize}
          onPage={(p) => setParams({ ...(raw !== 'open' && { status: raw }), ...(p > 1 && { page: String(p) }) })}
        />
      )}
    </section>
  );
}

// /admin/purchase-orders/:id: the order as it prints, with what has come so far and what to do next.
export function AdminPurchaseOrder() {
  const { id } = useParams();
  const [version, setVersion] = useState(0);
  const { data: o, error } = useFetch(`/admin/purchase-orders/${id}`, version);
  const [state, setState] = useState({ busy: false, error: null });
  if (error?.status === 404 || error?.status === 400) return <NotFound message="We couldn't find that order." />;
  if (error) return <p className="error">{error.message}</p>;
  if (!o) return <p className="muted">Loading…</p>;

  async function finish(action, question) {
    if (!window.confirm(question)) return;
    setState({ busy: true, error: null });
    try {
      await request(`/admin/purchase-orders/${o.id}/${action}`, { method: 'POST' });
      setState({ busy: false, error: null });
      setVersion((v) => v + 1);
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }
  const started = o.lines.some((l) => l.received > 0);
  const cost = (c) => (c === null ? '—' : formatPrice(c));

  return (
    <>
      <nav className="breadcrumb no-print" aria-label="Breadcrumb">
        <Link to="/admin/purchase-orders">Supplier orders</Link>
        <span aria-hidden>›</span>
        <span>#{o.number}</span>
      </nav>
      <section className="panel purchase-order">
        <p className="po-store">Bazaar</p>
        <h1>Supplier order #{o.number}</h1>
        <p>
          To <strong>{o.supplier}</strong> · {formatDate(o.createdAt)}
          {o.expectedOn && ` · needed by ${day(o.expectedOn)}`}
        </p>
        {o.note && <p>{o.note}</p>}
        <p className="no-print">
          <span className={`status po-${o.status}`}>{STATUS[o.status]}</span>
        </p>
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">Ordered</th>
                <th className="num">Price each</th>
                <th className="num">Total</th>
                <th className="num no-print">Received</th>
              </tr>
            </thead>
            <tbody>
              {o.lines.map((l) => (
                <tr key={`${l.productId}.${l.variantId ?? ''}`}>
                  <td>{l.title}</td>
                  <td className="num">{l.qty}</td>
                  <td className="num">{cost(l.unitCost)}</td>
                  <td className="num">{l.unitCost === null ? '—' : formatPrice(l.unitCost * l.qty)}</td>
                  <td className="num no-print">
                    {l.received}
                    {l.outstanding > 0 && o.status === 'open' && (
                      <span className="muted small block">{l.outstanding} to come</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small">
          {o.units} units{o.value !== null && `, ${formatPrice(o.value)} in all`}.
        </p>
        {o.deliveries.length > 0 && (
          <div className="no-print">
            <h2>Deliveries</h2>
            <ul>
              {o.deliveries.map((d) => (
                <li key={d.id}>
                  <Link to={`/admin/stock-receipts/${d.id}`}>Delivery #{d.number}</Link>, {formatDate(d.createdAt)}:{' '}
                  {d.units} units
                </li>
              ))}
            </ul>
          </div>
        )}
        {state.error && (
          <p className="error no-print" role="alert">
            {state.error}
          </p>
        )}
        <div className="form-actions no-print">
          <button type="button" className="btn" onClick={() => window.print()}>
            Print or save as PDF
          </button>
          {o.status === 'open' && (
            <>
              <Link to={`/admin/stock-receipts/new?po=${o.id}`} className="btn primary">
                Record a delivery
              </Link>
              {started ? (
                <button
                  type="button"
                  className="btn"
                  disabled={state.busy}
                  onClick={() => finish('close', 'Close this order? What hasn’t come is no longer expected.')}
                >
                  Close short
                </button>
              ) : (
                <button
                  type="button"
                  className="btn danger"
                  disabled={state.busy}
                  onClick={() => finish('cancel', 'Cancel this supplier order?')}
                >
                  Cancel order
                </button>
              )}
            </>
          )}
        </div>
      </section>
    </>
  );
}

let nextKey = 0;

// /admin/purchase-orders/new (`?suggested=1` starts from the dashboard's reorder suggestions): the supplier, then a
// line per product or option with how many to order and, if known, the price each.
export function AdminPurchaseOrderNew() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { data: receipts } = useFetch('/admin/stock-receipts');
  const { data: suggested } = useFetch(params.get('suggested') ? '/admin/purchase-orders/suggested' : null);
  const [lines, setLines] = useState(null);
  const [state, setState] = useState({ busy: false, error: null });
  const shown =
    lines ??
    (suggested?.lines ?? []).map((l) => ({
      key: `s:${l.productId}.${l.variantId ?? ''}`,
      product: { id: l.productId, title: l.title, variants: [] },
      variantId: l.variantId ?? '',
      fixed: true,
      note: `${l.stock} in stock, about ${l.daysLeft} days left`,
      qty: String(l.qty),
      unitCost: l.unitCost === null ? '' : toRupees(l.unitCost),
    }));

  const set = (key, field, value) => setLines(shown.map((l) => (l.key === key ? { ...l, [field]: value } : l)));
  const add = (p) => setLines([...shown, { key: nextKey++, product: p, variantId: '', qty: '', unitCost: '' }]);
  const remove = (key) => setLines(shown.filter((l) => l.key !== key));
  const total = shown.every((l) => l.unitCost !== '' && l.qty !== '')
    ? shown.reduce((s, l) => s + toPaise(l.unitCost) * Number(l.qty), 0)
    : null;

  async function submit(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null });
    try {
      const saved = await request('/admin/purchase-orders', {
        method: 'POST',
        body: {
          supplier: f.supplier,
          note: f.note,
          expectedOn: f.expectedOn || null,
          lines: shown.map((l) => ({
            productId: l.product.id,
            ...(l.variantId && { variantId: l.variantId }),
            qty: Number(l.qty),
            unitCost: l.unitCost === '' ? null : toPaise(l.unitCost),
          })),
        },
      });
      navigate(`/admin/purchase-orders/${saved.id}`);
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <section className="panel">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/admin/purchase-orders">Supplier orders</Link>
        <span aria-hidden>›</span>
        <span>New</span>
      </nav>
      <h1>New supplier order</h1>
      {suggested && (
        <p className="muted small">
          Filled in from the reorder suggestions (enough for about a month, less what&apos;s already on order). Remove
          what this supplier doesn&apos;t sell.
        </p>
      )}
      <form className="sale-form" onSubmit={submit} aria-label="New supplier order">
        <div className="address-grid">
          <label>
            Supplier
            <input name="supplier" required maxLength={80} list="po-suppliers" autoComplete="off" />
            <datalist id="po-suppliers">
              {receipts?.suppliers.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>
          <label>
            Needed by (optional)
            <input name="expectedOn" type="date" />
          </label>
        </div>
        {shown.length > 0 && (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Order</th>
                  <th>Price each (₹)</th>
                  <th>
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((l, i) => (
                  <tr key={l.key}>
                    <td>
                      {l.product.title}
                      {!l.fixed && l.product.variants.length > 0 && (
                        <select
                          required
                          value={l.variantId}
                          onChange={(e) => set(l.key, 'variantId', e.target.value)}
                          aria-label={`${l.product.variantName || 'Option'} of line ${i + 1}`}
                          className="block"
                        >
                          <option value="" disabled>
                            Choose {(l.product.variantName || 'an option').toLowerCase()}…
                          </option>
                          {l.product.variants.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.label} ({v.stock} in stock)
                            </option>
                          ))}
                        </select>
                      )}
                      {l.note && <span className="muted small block">{l.note}</span>}
                    </td>
                    <td>
                      <input
                        type="number"
                        min="1"
                        max="10000"
                        step="1"
                        required
                        value={l.qty}
                        onChange={(e) => set(l.key, 'qty', e.target.value)}
                        aria-label={`Order of line ${i + 1}`}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={l.unitCost}
                        onChange={(e) => set(l.key, 'unitCost', e.target.value)}
                        aria-label={`Price each of line ${i + 1}`}
                      />
                    </td>
                    <td>
                      <button type="button" className="link danger" onClick={() => remove(l.key)}>
                        Remove<span className="sr-only"> line {i + 1}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {suggested && shown.length === 0 && <p className="muted">Nothing needs ordering right now.</p>}
        <ProductSearch onPick={add} />
        <label>
          Note for the supplier (optional)
          <input name="note" maxLength={500} placeholder="Deliver between 10 am and 5 pm" />
        </label>
        {total !== null && shown.length > 0 && <p className="small">Total: {formatPrice(total)}</p>}
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        <button type="submit" className="btn primary" disabled={state.busy || shown.length === 0}>
          Make the order
        </button>
      </form>
    </section>
  );
}
