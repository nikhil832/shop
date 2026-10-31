import { Link, useSearchParams } from 'react-router';
import { query } from '../../api.js';
import { useFetch } from '../../useFetch.js';

// /admin/product-performance (stage 100): views, adds to cart and orders per product over 7, 30 or 90 days, to find
// what is looked at but not bought (often a price, photo or description to look at again).
export default function AdminProductPerformance() {
  const [params, setParams] = useSearchParams();
  const days = params.get('days') ?? '30';
  const sort = params.get('sort') ?? 'views';
  const notBought = params.get('notBought') === '1';
  const { data, error, loading } = useFetch(
    `/admin/product-performance${query({ days, sort, notBought: notBought ? '1' : '' })}`,
  );
  const set = (changes) => setParams(query({ days, sort, notBought: notBought ? '1' : '', ...changes }).slice(1));
  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/admin/products">Products</Link>
        <span aria-hidden>›</span>
        <span>Performance</span>
      </nav>
      <section className="panel">
        <h1>Product performance</h1>
        <p className="muted small">
          How often each product was looked at and added to the cart, and how often it was bought. Views are counted
          when a product page opens (staff aren&apos;t counted); nothing is kept about who looked.
        </p>
        <div className="admin-filters">
          <select aria-label="Period" value={days} onChange={(e) => set({ days: e.target.value })}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
          <select aria-label="Sort by" value={sort} onChange={(e) => set({ sort: e.target.value })}>
            <option value="views">Most viewed</option>
            <option value="carts">Most added to cart</option>
            <option value="shares">Most shared</option>
            <option value="orders">Most ordered</option>
            <option value="conversion">Best views to orders</option>
          </select>
          <label className="check">
            <input
              type="checkbox"
              checked={notBought}
              onChange={(e) => set({ notBought: e.target.checked ? '1' : '' })}
            />
            Only looked at, not bought
          </label>
        </div>
        {error && <p className="error">{error.message}</p>}
        {data?.items.length === 0 && (
          <p className="muted">
            {notBought
              ? `Nothing was viewed ${data.notBoughtViews} times or more without an order in this period.`
              : 'No views or orders in this period yet.'}
          </p>
        )}
        {data?.items.length > 0 && (
          <div className="table-wrap">
            <table className={`admin-table ${loading ? 'stale' : ''}`}>
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Views</th>
                  <th className="num">Added to cart</th>
                  <th className="num">Shared</th>
                  <th className="num">Orders</th>
                  <th className="num">Units</th>
                  <th className="num">Views to orders</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.productId}>
                    <td>
                      <Link to={`/admin/products/${r.productId}`}>{r.title}</Link>
                      {!r.active && <span className="muted small"> · hidden</span>}
                      {r.notBought && <span className="muted small block">Looked at, not bought</span>}
                    </td>
                    <td className="num">{r.views.toLocaleString('en-IN')}</td>
                    <td className="num">{r.carts.toLocaleString('en-IN')}</td>
                    <td className="num">{r.shares.toLocaleString('en-IN')}</td>
                    <td className="num">{r.orders.toLocaleString('en-IN')}</td>
                    <td className="num">{r.units.toLocaleString('en-IN')}</td>
                    <td className="num">{r.conversion === null ? '—' : `${r.conversion}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data?.total > data?.items.length && (
          <p className="muted small">
            Showing the first {data.items.length} of {data.total}.
          </p>
        )}
      </section>
    </>
  );
}
