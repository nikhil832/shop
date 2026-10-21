import { Link, useSearchParams } from 'react-router';
import { query } from '../../api.js';
import { ORDER_STATUS, formatDate, formatPrice, orderNumber } from '../../format.js';
import { useFetch } from '../../useFetch.js';
import Pager from '../../components/Pager.jsx';
import { StatusBadge } from '../Orders.jsx';

export default function AdminOrders() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const q = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const { data, error, loading } = useFetch(`/admin/orders${query({ status, q, page: page > 1 ? page : '' })}`);

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

      {error && <p className="error">{error.message}</p>}
      {data?.items.length === 0 && <p className="muted">No orders match.</p>}
      {data?.items.length > 0 && (
        <div className={`table-wrap ${loading ? 'stale' : ''}`}>
          <table className="admin-table">
            <thead>
              <tr>
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
