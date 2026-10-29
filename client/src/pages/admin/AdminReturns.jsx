import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { query, request } from '../../api.js';
import { formatDate, formatPrice, returnStatusLabel } from '../../format.js';
import { useFetch } from '../../useFetch.js';
import Pager from '../../components/Pager.jsx';

const FILTERS = [
  ['requested', 'To review'],
  ['approved', 'Refund to pay'],
  ['refund_failed', 'Refund failed'],
  ['refunded', 'Refunded'],
  ['declined', 'Declined'],
  ['', 'All'],
];

// Return requests: approve once the items are back (stock returns; online payments are refunded, COD ones the admin
// pays and then marks refunded), or decline with a reason the customer sees.
export default function AdminReturns() {
  const [params, setParams] = useSearchParams();
  // To review by default; "all" in the URL means no filter.
  const raw = params.get('status') ?? 'requested';
  const status = raw === 'all' ? '' : raw;
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [version, setVersion] = useState(0);
  const { data, error, loading } = useFetch(`/admin/returns${query({ status, page: page > 1 ? page : '' })}`, version);
  const [action, setAction] = useState({ busy: false, error: null });

  async function run(path, body) {
    setAction({ busy: true, error: null });
    try {
      await request(path, { method: 'POST', body });
      setAction({ busy: false, error: null });
      setVersion((v) => v + 1);
    } catch (err) {
      setAction({ busy: false, error: err.message });
    }
  }
  const approve = (r) => {
    const money = r.refund - r.refundCredit;
    const credit = r.refundCredit ? ` ${formatPrice(r.refundCredit)} goes to their store credit at once.` : '';
    return (
      window.confirm(
        r.refundMethod === 'credit'
          ? `Approve this return? The stock goes back and${credit}`
          : r.refundMethod === 'razorpay'
            ? `Approve this return? The stock goes back and ${formatPrice(money)} is refunded to the customer's payment.${credit}`
            : `Approve this return? The stock goes back; then pay the customer ${formatPrice(money)} and mark it refunded.${credit}`,
      ) && run(`/admin/returns/${r.id}/approve`)
    );
  };
  function decline(r) {
    const reason = window.prompt('Why is this return declined? The customer sees this.');
    if (reason?.trim()) run(`/admin/returns/${r.id}/decline`, { reason: reason.trim() });
  }

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Returns</h1>
        <Link to="/admin/exchanges">Exchanges</Link>
      </div>
      <p className="muted small">
        Approve a return once the items are back with you. Online payments are refunded at once; for Cash on Delivery,
        pay the customer (UPI or bank transfer), then mark it refunded.
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
            {data && s && <span className="count">{s === 'approved' ? data.counts.approved : data.counts[s]}</span>}
          </button>
        ))}
      </div>
      {(error || action.error) && (
        <p className="error" role="alert">
          {action.error ?? error.message}
        </p>
      )}
      {data?.items.length === 0 && <p className="muted">No returns here.</p>}
      {data?.items.length > 0 && (
        <div className={`table-wrap ${loading ? 'stale' : ''}`}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Items and reason</th>
                <th className="num">Refund</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/admin/orders/${r.orderId}`}>#{r.orderNumber ?? r.orderId.slice(-8).toUpperCase()}</Link>
                    <span className="muted small block">{formatDate(r.createdAt)}</span>
                  </td>
                  <td>
                    {r.customer?.name ?? '—'}
                    <span className="muted small block">{r.customer?.email}</span>
                  </td>
                  <td>
                    {r.items.map((i) => `${i.title} × ${i.qty}`).join(', ')}
                    <span className="muted small block">
                      {r.reasonText}
                      {r.note && `: ${r.note}`}
                    </span>
                    {r.declineReason && <span className="muted small block">Declined: {r.declineReason}</span>}
                    {r.refundError && <span className="error small block">{r.refundError}</span>}
                  </td>
                  <td className="num">
                    {formatPrice(r.refund)}
                    <span className="muted small block">
                      {{ razorpay: 'Online', manual: 'Cash on Delivery', credit: 'Store credit' }[r.refundMethod]}
                      {r.refundCredit > 0 && r.refundMethod !== 'credit' && ` + ${formatPrice(r.refundCredit)} credit`}
                    </span>
                  </td>
                  <td>
                    <div className="status-cell">
                      <span className={`status return-${r.status}`}>{returnStatusLabel(r, { admin: true })}</span>
                      {r.status === 'requested' && (
                        <>
                          <button type="button" className="link" onClick={() => approve(r)} disabled={action.busy}>
                            Approve<span className="sr-only"> return for order {r.orderNumber}</span>
                          </button>
                          <button
                            type="button"
                            className="link danger"
                            onClick={() => decline(r)}
                            disabled={action.busy}
                          >
                            Decline<span className="sr-only"> return for order {r.orderNumber}</span>
                          </button>
                        </>
                      )}
                      {r.status === 'approved' && r.refundMethod === 'manual' && (
                        <button
                          type="button"
                          className="link"
                          onClick={() => run(`/admin/returns/${r.id}/refunded`)}
                          disabled={action.busy}
                        >
                          Mark refunded<span className="sr-only"> for order {r.orderNumber}</span>
                        </button>
                      )}
                      {r.status === 'refund_failed' && (
                        <button
                          type="button"
                          className="link"
                          onClick={() => run(`/admin/returns/${r.id}/refund`)}
                          disabled={action.busy}
                        >
                          Retry refund<span className="sr-only"> for order {r.orderNumber}</span>
                        </button>
                      )}
                    </div>
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
