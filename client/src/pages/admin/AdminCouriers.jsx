import { Link, useSearchParams } from 'react-router';
import { query } from '../../api.js';
import { formatDate, orderNumber } from '../../format.js';
import { useFetch } from '../../useFetch.js';
import { DELIVERY_RATINGS } from '../../deliveryFeedback.js';

const percent = (n, of) => (of ? `${Math.round((n * 100) / of)}%` : '—');

// /admin/couriers (stage 123): per courier, the orders delivered in the period, how many came after the date promised
// at checkout, and what customers answered to "How was your delivery?", to see which courier to keep.
export default function AdminCouriers() {
  const [params, setParams] = useSearchParams();
  const days = params.get('days') ?? '90';
  const { data, error, loading } = useFetch(`/admin/delivery-feedback${query({ days })}`);
  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/admin/delivery">Delivery</Link>
        <span aria-hidden>›</span>
        <span>Courier report</span>
      </nav>
      <section className="panel">
        <h1>Courier report</h1>
        <p className="muted small">
          Orders delivered in the period, by the courier entered when shipping. &ldquo;After the promised date&rdquo;
          compares the delivery day with the date given at checkout (orders from before delivery dates aren&apos;t
          counted there). Customers can answer &ldquo;How was your delivery?&rdquo; for 30 days after it arrives.
        </p>
        <div className="admin-filters">
          <select
            aria-label="Period"
            value={days}
            onChange={(e) => setParams(query({ days: e.target.value }).slice(1))}
          >
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last 365 days</option>
          </select>
        </div>
        {error && <p className="error">{error.message}</p>}
        {data?.couriers.length === 0 && <p className="muted">No orders were delivered in this period.</p>}
        {data?.couriers.length > 0 && (
          <div className="table-wrap">
            <table className={`admin-table ${loading ? 'stale' : ''}`}>
              <thead>
                <tr>
                  <th>Courier</th>
                  <th className="num">Delivered</th>
                  <th className="num">After the promised date</th>
                  <th className="num">Answers</th>
                  <th className="num">On time</th>
                  <th className="num">Late</th>
                  <th className="num">Damaged</th>
                </tr>
              </thead>
              <tbody>
                {data.couriers.map((c) => (
                  <tr key={c.courier.toLowerCase()}>
                    <td>{c.courier || <span className="muted">No courier entered</span>}</td>
                    <td className="num">{c.delivered}</td>
                    <td className="num">
                      {c.afterDate} <span className="muted small">({percent(c.afterDate, c.withDate)})</span>
                    </td>
                    <td className="num">{c.answers}</td>
                    <td className="num">{percent(c.onTime, c.answers)}</td>
                    <td className="num">{percent(c.late, c.answers)}</td>
                    <td className="num">{percent(c.damaged, c.answers)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {data?.notes.length > 0 && (
        <section className="panel" aria-labelledby="courier-notes">
          <h2 id="courier-notes">What customers said</h2>
          <ul className="cancel-notes">
            {data.notes.map((n) => (
              <li key={n.orderId}>
                &ldquo;{n.note}&rdquo;{' '}
                <span className="muted small">
                  {DELIVERY_RATINGS[n.rating]} · {n.courier || 'No courier entered'} ·{' '}
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
