import { Link, useParams, useSearchParams } from 'react-router';
import { query } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { formatDate, formatTime } from '../../format.js';
import { can } from '../../permissions.js';
import { useFetch } from '../../useFetch.js';
import Pager from '../../components/Pager.jsx';

// The same reasons as server/src/stockHistory.js.
const REASONS = {
  ordered: 'Ordered',
  cancelled: 'Cancelled by the customer',
  store_cancelled: 'Cancelled by the store',
  released: 'Unpaid order released',
  returned_to_sender: 'Returned to sender',
  received: 'Received',
  returned: 'Return approved',
  exchange_reserved: 'Set aside for an exchange',
  exchange_released: 'Exchange called off',
  exchange_returned: 'Exchanged item back',
  edited: 'Changed by hand',
  imported: 'CSV import',
  added: 'Product added',
};

const signed = (n) => (n > 0 ? `+${n}` : `−${-n}`);

function Why({ entry, admin }) {
  const { order } = entry;
  return (
    <>
      {REASONS[entry.reason] ?? entry.reason}
      {order && (
        <>
          {' · '}
          <Link to={`/admin/orders/${order.id}`}>Order #{order.number ?? order.id.slice(-8).toUpperCase()}</Link>
        </>
      )}
      {entry.receipt && (
        <>
          {' · '}
          {/* Packers see the number; the delivery's page is for admins. */}
          {admin ? (
            <Link to={`/admin/stock-receipts/${entry.receipt.id}`}>Delivery #{entry.receipt.number}</Link>
          ) : (
            `Delivery #${entry.receipt.number}`
          )}
        </>
      )}
      {entry.by && <span className="muted"> · {entry.by}</span>}
    </>
  );
}

// /admin/products/:id/stock: every change to a product's stock, newest first, for admins and packers. With variants,
// the list can show one of them (`?variant=`).
export default function AdminStockHistory() {
  const { id } = useParams();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const variant = params.get('variant') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const { data, error, loading } = useFetch(
    `/admin/products/${id}/stock-history${query({ variant, page: page > 1 ? page : '' })}`,
  );
  const product = data?.product;
  const hasVariants = product?.variants.length > 0;
  const update = (changes) => {
    const next = { variant, ...changes };
    setParams(query({ ...next, page: changes.page > 1 ? changes.page : '' }).slice(1));
  };

  return (
    <>
      {can(user, '*') && product && (
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <Link to="/admin/products">Products</Link>
          <span aria-hidden>›</span>
          <Link to={`/admin/products/${product.id}`}>{product.title}</Link>
          <span aria-hidden>›</span>
          <span>Stock history</span>
        </nav>
      )}
      <section className="panel">
        <div className="admin-head">
          <h1>Stock history{product && `: ${product.title}`}</h1>
          {product && can(user, '*') && (
            <Link
              to={`/admin/stock-receipts/new?product=${product.id}${variant && variant !== 'product' ? `&variant=${variant}` : ''}`}
              className="btn small"
            >
              Receive stock
            </Link>
          )}
        </div>
        <p className="muted small">
          Every change to this product&apos;s stock, newest first: deliveries, orders, cancellations, returns, unpaid
          orders released, and changes by hand or from a CSV file. Kept for a year; changes from before this list
          existed aren&apos;t in it.
        </p>
        {product && (
          <p>
            In stock now: <strong>{product.stock}</strong>
            {hasVariants && (
              <span className="muted"> ({product.variants.map((v) => `${v.label}: ${v.stock}`).join(', ')})</span>
            )}
          </p>
        )}
        {hasVariants && (
          <div className="admin-filters">
            <select aria-label="Option" value={variant} onChange={(e) => update({ variant: e.target.value })}>
              <option value="">All options</option>
              {product.variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {error && <p className="error">{error.message}</p>}
        {data?.items.length === 0 && <p className="muted">No stock changes recorded yet.</p>}
        {data?.items.length > 0 && (
          <div className="table-wrap">
            <table className={`admin-table ${loading ? 'stale' : ''}`}>
              <thead>
                <tr>
                  <th>When</th>
                  {hasVariants && <th>Option</th>}
                  <th className="num">Change</th>
                  <th className="num">Stock after</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <time dateTime={e.at}>
                        {formatDate(e.at)}, {formatTime(e.at)}
                      </time>
                    </td>
                    {hasVariants && <td>{e.label ?? '—'}</td>}
                    <td className="num">{signed(e.change)}</td>
                    <td className="num">{e.after}</td>
                    <td>
                      <Why entry={e} admin={can(user, '*')} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={(p) => update({ page: p })} />}
      </section>
    </>
  );
}
