import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { query, request } from '../../api.js';
import Pager from '../../components/Pager.jsx';
import { formatDate, formatPrice } from '../../format.js';
import { useFetch } from '../../useFetch.js';

const FILTERS = [
  ['', 'All'],
  ['scheduled', 'To be sent'],
  ['sent', 'Sent'],
  ['redeemed', 'Redeemed'],
  ['cancelled', 'Cancelled'],
];
const STATUS = Object.fromEntries([...FILTERS.slice(1), ['expired', 'Ran out']]);
const REFUND = {
  refunding: 'Refund in progress',
  refunded: 'Refund started',
  refund_failed: 'Refund failed',
};

// Admin → Gift cards (stage 77): every paid card, and cancelling an unredeemed one (its buyer is refunded online).
export default function AdminGiftCards() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [version, setVersion] = useState(0);
  const { data, error, loading } = useFetch(
    `/admin/gift-cards${query({ status, page: page > 1 ? page : '' })}`,
    version,
  );
  const [action, setAction] = useState({ busy: false, error: null });

  async function run(path, question) {
    if (question && !window.confirm(question)) return;
    setAction({ busy: true, error: null });
    try {
      await request(path, { method: 'POST' });
      setAction({ busy: false, error: null });
      setVersion((v) => v + 1);
    } catch (err) {
      setAction({ busy: false, error: err.message });
    }
  }

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Gift cards</h1>
      </div>
      <p className="muted small">
        Cards customers bought for others. A card can be cancelled until it&apos;s redeemed: its code stops working and
        the buyer is refunded online. Redeemed cards became store credit.
      </p>
      <div className="status-tabs" role="group" aria-label="Filter by status">
        {FILTERS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={status === value}
            onClick={() => setParams(value ? { status: value } : {})}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <p className="error">{error.message}</p>}
      {action.error && (
        <p className="error" role="alert">
          {action.error}
        </p>
      )}
      {data?.items.length === 0 && <p className="muted">No gift cards here.</p>}
      {data?.items.length > 0 && (
        <div className="table-wrap">
          <table className={`admin-table ${loading ? 'stale' : ''}`}>
            <thead>
              <tr>
                <th>Card</th>
                <th>From</th>
                <th>To</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{formatPrice(c.amount)}</strong>
                    <span className="muted small block">
                      Bought {formatDate(c.createdAt)}
                      {c.last4 && ` · code ending ${c.last4}`}
                    </span>
                  </td>
                  <td>
                    <Link to={`/admin/customers/${c.buyer.id}`}>{c.buyer.name}</Link>
                    {c.buyer.email && <span className="muted small block">{c.buyer.email}</span>}
                  </td>
                  <td>
                    {c.recipient.name}
                    <span className="muted small block">{c.recipient.email}</span>
                  </td>
                  <td>
                    {STATUS[c.status] ?? c.status}
                    <span className="muted small block">
                      {c.status === 'scheduled' && `Goes on ${formatDate(c.sendAt)}`}
                      {c.status === 'sent' && `Until ${formatDate(c.expiresAt)}`}
                      {c.redeemedAt && `On ${formatDate(c.redeemedAt)}`}
                      {REFUND[c.payment.status]}
                    </span>
                    {c.payment.refundError && <span className="error small block">{c.payment.refundError}</span>}
                  </td>
                  <td>
                    {(c.status === 'scheduled' || c.status === 'sent') && (
                      <button
                        type="button"
                        className="link danger"
                        disabled={action.busy}
                        onClick={() =>
                          run(
                            `/admin/gift-cards/${c.id}/cancel`,
                            `Cancel this ${formatPrice(c.amount)} gift card for ${c.recipient.name}? Its code stops working and ${c.buyer.name} is refunded.`,
                          )
                        }
                      >
                        Cancel and refund<span className="sr-only"> the card for {c.recipient.name}</span>
                      </button>
                    )}
                    {c.payment.status === 'refund_failed' && (
                      <button
                        type="button"
                        className="link"
                        disabled={action.busy}
                        onClick={() => run(`/admin/gift-cards/${c.id}/refund`)}
                      >
                        Try the refund again
                      </button>
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
          onPage={(p) => setParams(query({ status, page: p > 1 ? p : '' }).slice(1))}
        />
      )}
    </section>
  );
}
