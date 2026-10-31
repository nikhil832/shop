import { Link, useSearchParams } from 'react-router';
import { query } from '../../api.js';
import { formatDate, orderNumber } from '../../format.js';
import { useFetch } from '../../useFetch.js';

// /admin/return-reasons (stage 125): which products come back, how often against the units sold, and why, for orders
// placed in the period. Shows which descriptions, photos or size guides to look at again.
export default function AdminReturnReasons() {
  const [params, setParams] = useSearchParams();
  const days = params.get('days') ?? '90';
  const { data, error, loading } = useFetch(`/admin/return-reasons${query({ days })}`);
  const total = data?.reasons.reduce((n, r) => n + r.units, 0) ?? 0;
  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/admin/returns">Returns</Link>
        <span aria-hidden>›</span>
        <span>Return reasons</span>
      </nav>
      <section className="panel">
        <h1>Return reasons</h1>
        <p className="muted small">
          Items from orders placed in the period that customers sent back or exchanged (declined and called-off requests
          aren&apos;t counted), against the units sold in those orders. The newest orders can still be returned, so
          their figures may grow.
        </p>
        <div className="admin-filters">
          <select
            aria-label="Period"
            value={days}
            onChange={(e) => setParams(query({ days: e.target.value }).slice(1))}
          >
            <option value="30">Orders from the last 30 days</option>
            <option value="90">Orders from the last 90 days</option>
            <option value="365">Orders from the last 365 days</option>
          </select>
        </div>
        {error && <p className="error">{error.message}</p>}
        {data && total === 0 && <p className="muted">Nothing from these orders came back.</p>}
        {data && total > 0 && (
          <>
            <h2>Why items came back</h2>
            <ol className="reason-totals">
              {data.reasons.map((r) => (
                <li key={r.reason}>
                  <span>{r.label}</span>
                  <span>
                    {r.units} {r.units === 1 ? 'item' : 'items'} ({Math.round((r.units * 100) / total)}%)
                  </span>
                </li>
              ))}
            </ol>
            <h2>By product</h2>
            {/* Focusable, so keyboards can scroll it on phones. */}
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Returns by product">
              <table className={`admin-table return-reasons-table ${loading ? 'stale' : ''}`}>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="num">Sold</th>
                    <th className="num">Returned</th>
                    <th className="num">Exchanged</th>
                    <th className="num">Came back</th>
                    <th>Main reasons</th>
                  </tr>
                </thead>
                <tbody>
                  {data.products.map((p) => (
                    <tr key={p.productId}>
                      <td>
                        <Link to={`/admin/products/${p.productId}`}>{p.title}</Link>
                      </td>
                      <td className="num">{p.sold}</td>
                      <td className="num">{p.returned}</td>
                      <td className="num">{p.exchanged}</td>
                      <td className="num">{p.rate === null ? '—' : `${p.rate}%`}</td>
                      <td className="small">
                        {p.reasons
                          .slice(0, 2)
                          .map((r) => `${r.label} (${r.units})`)
                          .join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      {data?.notes.length > 0 && (
        <section className="panel" aria-labelledby="return-notes">
          <h2 id="return-notes">What customers said</h2>
          <ul className="cancel-notes">
            {data.notes.map((n) => (
              <li key={n.id}>
                &ldquo;{n.note}&rdquo;{' '}
                <span className="muted small">
                  {n.label} · {n.titles.join(', ')} ·{' '}
                  <Link to={`/admin/orders/${n.orderId}`}>
                    Order #{orderNumber({ number: n.number, id: n.orderId })}
                  </Link>
                  , {formatDate(n.at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
