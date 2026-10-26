import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { query, request } from '../../api.js';
import { ORDER_STATUS, formatDate, formatPrice, orderNumber } from '../../format.js';
import { useFetch } from '../../useFetch.js';
import Pager from '../../components/Pager.jsx';
import { StatusBadge } from '../Orders.jsx';

export default function AdminOrders() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const q = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const path = `/admin/orders${query({ status, q, page: page > 1 ? page : '' })}`;
  const [version, setVersion] = useState(0);
  const { data, error, loading } = useFetch(path, version);
  // Orders ticked on this page of the list (a new page or filter starts with none), and the last bulk result.
  const [selection, setSelection] = useState({ path, ids: [] });
  const selected = selection.path === path ? selection.ids : [];
  const [bulk, setBulk] = useState({ busy: false, result: null, error: null });

  const toggle = (id) =>
    setSelection({ path, ids: selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id] });
  const allOnPage = data?.items.length > 0 && data.items.every((o) => selected.includes(o.id));
  const toggleAll = () => setSelection({ path, ids: allOnPage ? [] : data.items.map((o) => o.id) });

  async function shipSelected() {
    const n = selected.length;
    if (!window.confirm(`Mark ${n} ${n === 1 ? 'order' : 'orders'} shipped? Each customer is emailed.`)) return;
    setBulk({ busy: true, result: null, error: null });
    try {
      const result = await request('/admin/orders/ship', { method: 'POST', body: { ids: selected } });
      setBulk({ busy: false, result, error: null });
      setSelection({ path, ids: [] });
      setVersion((v) => v + 1);
    } catch (err) {
      setBulk({ busy: false, result: null, error: err.message });
    }
  }

  // Any change other than the page goes back to page 1.
  const update = (changes) => {
    const next = { status, q, ...changes };
    setParams(query({ ...next, page: changes.page > 1 ? changes.page : '' }).slice(1));
  };

  function search(e) {
    e.preventDefault();
    update({ q: new FormData(e.currentTarget).get('q').trim() });
  }

  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : null;

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Orders</h1>
        <form key={q} className="admin-search" role="search" onSubmit={search}>
          <input
            name="q"
            type="search"
            defaultValue={q}
            placeholder="Order number, name or email"
            aria-label="Find orders"
          />
          <button type="submit" className="btn small">
            Find
          </button>
        </form>
      </div>

      <div className="status-tabs" role="group" aria-label="Filter by status">
        {['', ...Object.keys(ORDER_STATUS)].map((s) => (
          <button
            key={s}
            type="button"
            className={s === status ? 'active' : ''}
            aria-pressed={s === status}
            onClick={() => update({ status: s })}
          >
            {s ? ORDER_STATUS[s] : 'All'}
            {data && <span className="count">{s ? data.counts[s] : total}</span>}
          </button>
        ))}
      </div>

      {bulk.result && (
        <div className="notice" role="status">
          <p>
            {bulk.result.shipped.length
              ? `Marked ${bulk.result.shipped.length} ${bulk.result.shipped.length === 1 ? 'order' : 'orders'} shipped.`
              : 'No orders were shipped.'}
          </p>
          {bulk.result.skipped.length > 0 && (
            <ul className="small">
              {bulk.result.skipped.map((s) => (
                <li key={s.id}>
                  {s.number ? `#${s.number}` : 'An order'}: {s.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {bulk.error && (
        <p className="error" role="alert">
          {bulk.error}
        </p>
      )}
      {selected.length > 0 && (
        <div className="bulk-bar" role="group" aria-label="Selected orders">
          <strong>{selected.length} selected</strong>
          <Link className="btn small" to={`/admin/orders/slips?ids=${selected.join(',')}`}>
            Print packing slips
          </Link>
          <button type="button" className="btn primary small" disabled={bulk.busy} onClick={shipSelected}>
            Mark shipped
          </button>
          <button type="button" className="link" onClick={() => setSelection({ path, ids: [] })}>
            Clear
          </button>
        </div>
      )}
      {error && <p className="error">{error.message}</p>}
      {data?.items.length === 0 && <p className="muted">No orders match.</p>}
      {data?.items.length > 0 && (
        <div className={`table-wrap ${loading ? 'stale' : ''}`}>
          <table className="admin-table">
            <thead>
              <tr>
                <th className="select-cell">
                  <input
                    type="checkbox"
                    checked={allOnPage}
                    onChange={toggleAll}
                    aria-label="Select all orders on this page"
                  />
                </th>
                <th>Order</th>
                <th>Date</th>
                <th>Customer</th>
                <th className="num">Items</th>
                <th className="num">Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((o) => (
                <tr key={o.id}>
                  <td className="select-cell">
                    <input
                      type="checkbox"
                      checked={selected.includes(o.id)}
                      onChange={() => toggle(o.id)}
                      aria-label={`Select order #${orderNumber(o)}`}
                    />
                  </td>
                  <td>
                    <Link to={`/admin/orders/${o.id}`}>#{orderNumber(o)}</Link>
                  </td>
                  <td>{formatDate(o.createdAt)}</td>
                  <td>
                    {o.customer?.name ?? 'Deleted account'}
                    <span className="muted small block">{o.customer?.email}</span>
                  </td>
                  <td className="num">{o.items.reduce((n, i) => n + i.qty, 0)}</td>
                  <td className="num">{formatPrice(o.total)}</td>
                  <td>
                    <StatusBadge status={o.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={(p) => update({ page: p })} />}
    </section>
  );
}
