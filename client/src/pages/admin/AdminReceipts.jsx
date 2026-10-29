import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { query, request } from '../../api.js';
import Pager from '../../components/Pager.jsx';
import { formatDate, formatPrice, toPaise, toRupees } from '../../format.js';
import { useFetch } from '../../useFetch.js';
import NotFound from '../NotFound.jsx';

// Receiving stock (stage 81): deliveries from suppliers. Each adds stock, shows as "Received" in the stock history,
// and (unless switched off) averages the delivery's price into the cost price.

// /admin/stock-receipts: deliveries, newest first, optionally one supplier's.
export function AdminReceipts() {
  const [params, setParams] = useSearchParams();
  const supplier = params.get('supplier') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const { data, error, loading } = useFetch(`/admin/stock-receipts${query({ supplier, page: page > 1 ? page : '' })}`);
  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Receiving</h1>
        <Link to="/admin/stock-receipts/new" className="btn primary">
          Record a delivery
        </Link>
      </div>
      <p className="muted small">
        Deliveries from suppliers. Recording one adds the stock, shows it as &ldquo;Received&rdquo; in each
        product&apos;s stock history, and averages its price into the cost price.
      </p>
      {data?.suppliers.length > 1 && (
        <div className="admin-filters">
          <select
            aria-label="Supplier"
            value={supplier}
            onChange={(e) => setParams(query({ supplier: e.target.value }).slice(1))}
          >
            <option value="">All suppliers</option>
            {data.suppliers.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && <p className="error">{error.message}</p>}
      {data?.items.length === 0 && <p className="muted">No deliveries recorded yet.</p>}
      {data?.items.length > 0 && (
        <div className="table-wrap">
          <table className={`admin-table ${loading ? 'stale' : ''}`}>
            <thead>
              <tr>
                <th>Delivery</th>
                <th>Supplier</th>
                <th className="num">Units</th>
                <th className="num">Value</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/admin/stock-receipts/${r.id}`}>#{r.number}</Link>
                    <span className="muted small block">
                      {formatDate(r.createdAt)} · {r.by}
                    </span>
                  </td>
                  <td>
                    {r.supplier}
                    {r.reference && <span className="muted small block">Invoice {r.reference}</span>}
                  </td>
                  <td className="num">{r.units}</td>
                  <td className="num">{r.value === null ? '—' : formatPrice(r.value)}</td>
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
          onPage={(p) => setParams(query({ supplier, page: p > 1 ? p : '' }).slice(1))}
        />
      )}
    </section>
  );
}

// /admin/stock-receipts/:id: what came in, with each line's stock and cost price before and after.
export function AdminReceipt() {
  const { id } = useParams();
  const { data: r, error } = useFetch(`/admin/stock-receipts/${id}`);
  if (error?.status === 404 || error?.status === 400) return <NotFound message="We couldn't find that delivery." />;
  if (error) return <p className="error">{error.message}</p>;
  if (!r) return <p className="muted">Loading…</p>;
  const cost = (c) => (c === null ? '—' : formatPrice(c));
  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/admin/stock-receipts">Receiving</Link>
        <span aria-hidden>›</span>
        <span>#{r.number}</span>
      </nav>
      <section className="panel">
        <h1>
          Delivery #{r.number} from {r.supplier}
        </h1>
        <p className="muted small">
          {formatDate(r.createdAt)} · recorded by {r.by}
          {r.reference && ` · supplier's invoice ${r.reference}`}
          {r.purchaseOrder && (
            <>
              {' · for '}
              <Link to={`/admin/purchase-orders/${r.purchaseOrder.id}`}>supplier order #{r.purchaseOrder.number}</Link>
            </>
          )}
          {!r.updateCost && ' · cost prices left as they were'}
        </p>
        {r.note && <p>{r.note}</p>}
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">Received</th>
                <th className="num">Each</th>
                <th className="num">Stock</th>
                <th className="num">Cost price</th>
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={`${l.productId}.${l.variantId ?? ''}`}>
                  <td>
                    <Link to={`/admin/products/${l.productId}/stock${l.variantId ? `?variant=${l.variantId}` : ''}`}>
                      {l.title}
                    </Link>
                  </td>
                  <td className="num">+{l.qty}</td>
                  <td className="num">{cost(l.unitCost)}</td>
                  <td className="num">
                    {l.stockBefore} → {l.stockAfter}
                  </td>
                  <td className="num">
                    {l.costAfter === l.costBefore ? cost(l.costAfter) : `${cost(l.costBefore)} → ${cost(l.costAfter)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small">
          {r.units} units{r.value !== null && `, ${formatPrice(r.value)} in all`}.
        </p>
      </section>
    </>
  );
}

let nextKey = 0;

// "12 in stock · cost now ₹220" for a line's product, or its chosen option.
function onHand(line) {
  if (line.fixed) return '';
  const own = line.product.variants.length ? line.product.variants.find((v) => v.id === line.variantId) : line.product;
  if (!own) return '';
  return `${own.stock} in stock${own.cost != null ? ` · cost now ₹${toRupees(own.cost)}` : ''}`;
}

// Finds products to add to the delivery (title or brand, 2+ characters).
export function ProductSearch({ onPick }) {
  const [q, setQ] = useState('');
  const { data } = useFetch(q.trim().length >= 2 ? `/admin/products${query({ q: q.trim() })}` : null);
  return (
    <div className="sale-picker">
      <label>
        Add a product
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a title or brand" />
      </label>
      {data?.items.length > 0 && (
        <ul className="sale-results">
          {data.items.slice(0, 8).map((p) => (
            <li key={p.id}>
              <span>{p.title}</span>
              <button
                type="button"
                className="link"
                onClick={() => {
                  onPick(p);
                  setQ('');
                }}
              >
                Add<span className="sr-only"> {p.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// /admin/stock-receipts/new (`?product=<id>` starts with that product): the supplier, then a line per product or
// option with how many came and, if known, the price each.
export function AdminReceiptNew() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { data: list } = useFetch('/admin/stock-receipts');
  const start = params.get('product');
  const { data: first } = useFetch(start ? `/admin/products/${start}` : null);
  // A delivery against a supplier order (stage 93): its outstanding lines, already filled in.
  const poId = params.get('po');
  const { data: po } = useFetch(poId ? `/admin/purchase-orders/${poId}` : null);
  const [lines, setLines] = useState(null);
  const [state, setState] = useState({ busy: false, error: null });
  // The product (or the order's lines) the page was opened for, until the admin changes the list.
  const fromOrder = po
    ? po.lines
        .filter((l) => l.outstanding > 0)
        .map((l) => ({
          key: `po:${l.productId}.${l.variantId ?? ''}`,
          // Fixed to the ordered product and option, so no option to choose.
          product: { id: l.productId, title: l.title, variants: [] },
          variantId: l.variantId ?? '',
          fixed: true,
          qty: String(l.outstanding),
          unitCost: l.unitCost === null ? '' : toRupees(l.unitCost),
        }))
    : [];
  const shown =
    lines ??
    (po
      ? fromOrder
      : first
        ? [{ key: 'start', product: first, variantId: params.get('variant') ?? '', qty: '', unitCost: '' }]
        : []);

  const set = (key, field, value) => setLines(shown.map((l) => (l.key === key ? { ...l, [field]: value } : l)));
  const add = (p) => setLines([...shown, { key: nextKey++, product: p, variantId: '', qty: '', unitCost: '' }]);
  const remove = (key) => setLines(shown.filter((l) => l.key !== key));

  async function submit(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null });
    try {
      const saved = await request('/admin/stock-receipts', {
        method: 'POST',
        body: {
          supplier: f.supplier,
          reference: f.reference,
          note: f.note,
          updateCost: f.updateCost === 'on',
          ...(po && { purchaseOrderId: po.id }),
          lines: shown.map((l) => ({
            productId: l.product.id,
            ...(l.variantId && { variantId: l.variantId }),
            qty: Number(l.qty),
            unitCost: l.unitCost === '' ? null : toPaise(l.unitCost),
          })),
        },
      });
      navigate(`/admin/stock-receipts/${saved.id}`);
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <section className="panel">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/admin/stock-receipts">Receiving</Link>
        <span aria-hidden>›</span>
        <span>New delivery</span>
      </nav>
      <h1>Record a delivery</h1>
      {po && (
        <p className="notice">
          For <Link to={`/admin/purchase-orders/${po.id}`}>supplier order #{po.number}</Link> from {po.supplier}: the
          lines still to come are filled in. Change the numbers to what actually arrived.
        </p>
      )}
      <form className="sale-form" onSubmit={submit} aria-label="Record a delivery">
        <div className="address-grid">
          <label>
            Supplier
            <input
              key={po?.id ?? 'none'}
              name="supplier"
              required
              maxLength={80}
              list="suppliers"
              autoComplete="off"
              defaultValue={po?.supplier ?? ''}
            />
            <datalist id="suppliers">
              {list?.suppliers.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>
          <label>
            Their invoice number (optional)
            <input name="reference" maxLength={40} />
          </label>
        </div>
        {shown.length > 0 && (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Received</th>
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
                      {l.product.variants.length > 0 && (
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
                      <span className="muted small block">{onHand(l)}</span>
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
                        aria-label={`Received of line ${i + 1}`}
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
        <ProductSearch onPick={add} />
        <label>
          Note (optional)
          <input name="note" maxLength={500} placeholder="Two boxes damaged, returned to supplier" />
        </label>
        <label className="check">
          <input name="updateCost" type="checkbox" defaultChecked />
          Update cost prices: the average of the stock on hand and this delivery
        </label>
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        <button type="submit" className="btn primary" disabled={state.busy || shown.length === 0}>
          Add to stock
        </button>
      </form>
    </section>
  );
}
