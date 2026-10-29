import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { query, request } from '../../api.js';
import { exchangeStatusLabel, formatDate } from '../../format.js';
import { useFetch } from '../../useFetch.js';
import Pager from '../../components/Pager.jsx';
import { ShipmentForm } from './AdminOrder.jsx';

const FILTERS = [
  ['requested', 'To review'],
  ['approved', 'To ship'],
  ['shipped', 'Shipped'],
  ['delivered', 'Delivered'],
  ['declined', 'Declined'],
  ['', 'All'],
];

// Exchanges (stage 89): another option of the same product at the same price, set aside when the customer asked.
// Approve once the item is back (its stock returns), then ship the new one and mark it delivered; or decline with a
// reason the customer sees (the set-aside option goes back on sale).
export default function AdminExchanges() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('status') ?? 'requested';
  const status = raw === 'all' ? '' : raw;
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [version, setVersion] = useState(0);
  const { data, error, loading } = useFetch(
    `/admin/exchanges${query({ status, page: page > 1 ? page : '' })}`,
    version,
  );
  const [action, setAction] = useState({ busy: false, error: null });
  // The exchange whose tracking form is open (one at a time).
  const [shipping, setShipping] = useState(null);

  async function run(path, body) {
    setAction({ busy: true, error: null });
    try {
      await request(path, { method: 'POST', body });
      setAction({ busy: false, error: null });
      setShipping(null);
      setVersion((v) => v + 1);
    } catch (err) {
      setAction({ busy: false, error: err.message });
    }
  }
  const approve = (x) =>
    window.confirm('Approve this exchange? Do this once the item is back: its stock goes back on sale.') &&
    run(`/admin/exchanges/${x.id}/approve`);
  function decline(x) {
    const reason = window.prompt('Why is this exchange declined? The customer sees this.');
    if (reason?.trim()) run(`/admin/exchanges/${x.id}/decline`, { reason: reason.trim() });
  }
  const number = (x) => x.orderNumber ?? x.orderId.slice(-8).toUpperCase();

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Exchanges</h1>
        <Link to="/admin/returns">Returns</Link>
      </div>
      <p className="muted small">
        Customers swap an item for another size or colour at the same price; the new one is set aside when they ask.
        Approve once their item is back with you, then send the new one.
      </p>
      <div className="status-tabs" role="group" aria-label="Filter by status">
        {FILTERS.map(([s, label]) => (
          <button
            key={s}
            type="button"
            className={s === status ? 'active' : ''}
            aria-pressed={s === status}
            onClick={() => setParams(s === 'requested' ? {} : { status: s || 'all' })}
          >
            {label}
            {data && s && <span className="count">{data.counts[s]}</span>}
          </button>
        ))}
      </div>
      {(error || action.error) && (
        <p className="error" role="alert">
          {action.error ?? error.message}
        </p>
      )}
      {data?.items.length === 0 && <p className="muted">No exchanges here.</p>}
      {data?.items.length > 0 && (
        <div className={`table-wrap ${loading ? 'stale' : ''}`}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Items and reason</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((x) => (
                <tr key={x.id}>
                  <td>
                    <Link to={`/admin/orders/${x.orderId}`}>#{number(x)}</Link>
                    <span className="muted small block">{formatDate(x.createdAt)}</span>
                  </td>
                  <td>
                    {x.customer?.name ?? '—'}
                    <span className="muted small block">{x.customer?.email}</span>
                  </td>
                  <td>
                    {x.items.map((i) => (
                      <span key={i.index} className="block">
                        {i.title}: {i.fromLabel} → <strong>{i.toLabel}</strong> × {i.qty}
                      </span>
                    ))}
                    <span className="muted small block">
                      {x.reasonText}
                      {x.note && `: ${x.note}`}
                    </span>
                    {x.declineReason && <span className="muted small block">Declined: {x.declineReason}</span>}
                    {x.shipment?.trackingNumber && (
                      <span className="muted small block">
                        {x.shipment.courier} {x.shipment.trackingNumber}
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="status-cell">
                      <span className={`status return-${x.status}`}>{exchangeStatusLabel(x, { admin: true })}</span>
                      {x.status === 'requested' && (
                        <>
                          <button type="button" className="link" onClick={() => approve(x)} disabled={action.busy}>
                            Approve<span className="sr-only"> exchange for order {number(x)}</span>
                          </button>
                          <button
                            type="button"
                            className="link danger"
                            onClick={() => decline(x)}
                            disabled={action.busy}
                          >
                            Decline<span className="sr-only"> exchange for order {number(x)}</span>
                          </button>
                        </>
                      )}
                      {x.status === 'approved' && shipping !== x.id && (
                        <button type="button" className="link" onClick={() => setShipping(x.id)}>
                          Ship new item<span className="sr-only"> for order {number(x)}</span>
                        </button>
                      )}
                      {x.status === 'shipped' && (
                        <button
                          type="button"
                          className="link"
                          onClick={() => run(`/admin/exchanges/${x.id}/delivered`)}
                          disabled={action.busy}
                        >
                          Mark delivered<span className="sr-only"> exchange for order {number(x)}</span>
                        </button>
                      )}
                    </div>
                    {shipping === x.id && (
                      <ShipmentForm
                        submitLabel="Mark as shipped"
                        busy={action.busy}
                        onSubmit={(shipment) => run(`/admin/exchanges/${x.id}/ship`, { shipment })}
                        onCancel={() => setShipping(null)}
                      />
                    )}
                  </td>
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
          onPage={(p) => setParams({ ...(raw !== 'requested' && { status: raw }), ...(p > 1 && { page: String(p) }) })}
        />
      )}
    </section>
  );
}
