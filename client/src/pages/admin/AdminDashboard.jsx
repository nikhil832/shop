import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ORDER_STATUS, formatPrice } from '../../format.js';
import { request } from '../../api.js';
import { useFetch } from '../../useFetch.js';

const PERIODS = [7, 30, 90];

const compact = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  notation: 'compact',
  maximumFractionDigits: 1,
});
// Axis labels: ₹1.2K, ₹3L.
const formatShort = (paise) => compact.format(paise / 100);
// Dates from the API are India-time days ("2026-10-23"); shown as "23 Oct", read as UTC so they don't shift.
const dayFormat = (options) => new Intl.DateTimeFormat('en-IN', { ...options, timeZone: 'UTC' });
const shortDay = dayFormat({ day: 'numeric', month: 'short' });
const longDay = dayFormat({ weekday: 'short', day: 'numeric', month: 'short' });
const formatDay = (date) => shortDay.format(new Date(date));
const formatLongDay = (date) => longDay.format(new Date(date));

// Downloads orders between two dates as a CSV. A plain GET form: the browser saves the file the API sends.
// The dates start as the dashboard's period (remounted with a `key` when it changes).
function ExportOrders({ from, to }) {
  const [error, setError] = useState(null);
  const [report, setReport] = useState('orders');
  function check(e) {
    const { from: start, to: end } = Object.fromEntries(new FormData(e.currentTarget));
    if (start > end) {
      e.preventDefault();
      setError('The end date must be on or after the start date');
    } else {
      setError(null);
    }
  }
  return (
    <form
      className="panel export-form"
      method="get"
      action="/api/admin/orders/export"
      onSubmit={check}
      aria-labelledby="export-orders"
    >
      <h2 id="export-orders">Export orders</h2>
      <p className="muted small">
        {report === 'gst'
          ? 'For the GST return: tax on sales (placed, shipped or delivered orders) between the two dates, by place of supply and rate. Only orders placed while GST invoices were on count; refunds of returns are not taken off.'
          : 'A CSV file for Excel or Google Sheets: one row per order placed between the two dates (India time, both included), with the customer, items, amounts in rupees (with GST for orders placed while it was on), payment and delivery city.'}
      </p>
      <div className="export-fields">
        <label>
          From
          <input type="date" name="from" defaultValue={from} max={to} required />
        </label>
        <label>
          To
          <input type="date" name="to" defaultValue={to} max={to} required />
        </label>
        <label>
          Report
          <select name="report" value={report} onChange={(e) => setReport(e.target.value)}>
            <option value="orders">Orders</option>
            <option value="gst">GST summary</option>
          </select>
        </label>
        <label>
          Status
          <select name="status" defaultValue="" disabled={report === 'gst'}>
            <option value="">All</option>
            {Object.entries(ORDER_STATUS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn primary">
          Download CSV
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

// A round number at or above `value` for the top of the axis: 1, 2 or 5 times a power of ten.
function niceMax(value) {
  if (value <= 0) return 100_00;
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map((m) => m * power).find((m) => m >= value);
}

// "▲ 12% vs the 30 days before", or nothing to compare with.
function Change({ now, before, days }) {
  if (!before) return <p className="stat-change muted">No sales in the {days} days before</p>;
  const percent = Math.round(((now - before) / before) * 100);
  const arrow = percent > 0 ? '▲' : percent < 0 ? '▼' : '';
  return (
    <p className="stat-change muted">
      {arrow && <span aria-hidden="true">{arrow} </span>}
      {percent === 0 ? 'Same as' : `${Math.abs(percent)}% ${percent > 0 ? 'more than' : 'less than'}`} the {days} days
      before
    </p>
  );
}

function RevenueChart({ daily }) {
  const [hover, setHover] = useState(null);
  const top = niceMax(Math.max(...daily.map((d) => d.revenue)));
  const ticks = [0, 0.5, 1].map((f) => f * top);
  // Three dates under the axis: the first and last bars, and the middle one.
  const labelled = [0, Math.floor((daily.length - 1) / 2), daily.length - 1];
  const shown = hover === null ? null : daily[hover];

  return (
    <figure className="chart">
      <div className="chart-plot" onMouseLeave={() => setHover(null)}>
        <div className="chart-grid" aria-hidden="true">
          {ticks.map((tick) => (
            <div key={tick} className="chart-tick" style={{ bottom: `${(tick / top) * 100}%` }}>
              <span>{formatShort(tick)}</span>
            </div>
          ))}
        </div>
        <div className={`chart-bars${daily.length > 30 ? ' dense' : ''}`} aria-hidden="true">
          {daily.map((d, i) => (
            <div key={d.date} className={`chart-col${hover === i ? ' hover' : ''}`} onMouseEnter={() => setHover(i)}>
              {d.revenue > 0 && <div className="chart-bar" style={{ height: `${(d.revenue / top) * 100}%` }} />}
            </div>
          ))}
        </div>
        {shown && (
          <div
            className="chart-tooltip"
            role="status"
            // Centred over the bar, but kept inside the chart: near the edges it opens towards the middle.
            style={{
              left: `${((hover + 0.5) / daily.length) * 100}%`,
              transform: `translateX(${hover < daily.length / 5 ? -10 : hover > (daily.length * 4) / 5 ? -90 : -50}%)`,
            }}
          >
            <strong>{formatLongDay(shown.date)}</strong>
            <span>{formatPrice(shown.revenue)}</span>
            <span className="muted">
              {shown.orders} {shown.orders === 1 ? 'order' : 'orders'}
            </span>
            {shown.refunds > 0 && <span className="muted">{formatPrice(shown.refunds)} refunded since</span>}
          </div>
        )}
      </div>
      <div className="chart-dates" aria-hidden="true">
        {labelled.map((i) => (
          <span key={i} style={{ left: `${((i + 0.5) / daily.length) * 100}%` }}>
            {formatDay(daily[i].date)}
          </span>
        ))}
      </div>
      <details className="chart-table">
        <summary>Show as a table</summary>
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Orders</th>
                <th className="num">Sales</th>
                <th className="num">Refunded</th>
              </tr>
            </thead>
            <tbody>
              {daily.toReversed().map((d) => (
                <tr key={d.date}>
                  <td>{formatLongDay(d.date)}</td>
                  <td className="num">{d.orders}</td>
                  <td className="num">{formatPrice(d.revenue)}</td>
                  <td className="num">{d.refunds ? formatPrice(d.refunds) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

// The morning low-stock email, on or off for every admin. Saved as soon as it's ticked; back as it was if that fails.
function LowStockEmailSwitch({ enabled }) {
  const [state, setState] = useState({ on: enabled, busy: false, error: null });
  const change = async (on) => {
    setState({ on, busy: true, error: null });
    try {
      await request('/admin/dashboard/low-stock-email', { method: 'PUT', body: { enabled: on } });
      setState({ on, busy: false, error: null });
    } catch (err) {
      setState({ on: !on, busy: false, error: err.message });
    }
  };
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={state.on} disabled={state.busy} onChange={(e) => change(e.target.checked)} />
        Email this list to admins each morning
      </label>
      {state.error && <p className="error small">{state.error}</p>}
    </>
  );
}

export default function AdminDashboard() {
  const [params, setParams] = useSearchParams();
  const days = PERIODS.includes(Number(params.get('days'))) ? Number(params.get('days')) : 30;
  const { data, error, loading } = useFetch(`/admin/dashboard?days=${days}`);
  const setDays = (d) => setParams(d === 30 ? {} : { days: String(d) });

  return (
    <div className="admin-form">
      <div className="admin-head">
        <h1>Dashboard</h1>
        <div className="status-tabs" role="group" aria-label="Period">
          {PERIODS.map((d) => (
            <button
              key={d}
              type="button"
              className={d === days ? 'active' : ''}
              aria-pressed={d === days}
              onClick={() => setDays(d)}
            >
              Last {d} days
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error.message}
        </p>
      )}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (
        <div className={`dashboard${loading ? ' stale' : ''}`}>
          <p className="muted small">
            Sales are orders placed, shipped or delivered since {formatDay(data.daily[0].date)} (India time), with
            delivery and after discounts. Cancelled orders and unpaid online orders are left out. Revenue is after
            refunds of approved returns, counted on the day of the order they came from; the chart shows sales.
          </p>

          <section className="stat-grid" aria-label="Totals">
            <div className="panel stat">
              <h2>Revenue</h2>
              {/* Net of refunds from returns of these orders; the line below splits it. */}
              <p className="stat-value">{formatPrice(data.totals.netRevenue)}</p>
              {data.totals.refunds > 0 && (
                <p className="stat-change muted">
                  {formatPrice(data.totals.revenue)} in sales − {formatPrice(data.totals.refunds)} refunded
                </p>
              )}
              <Change now={data.totals.netRevenue} before={data.previous.netRevenue} days={days} />
            </div>
            <div className="panel stat">
              <h2>Orders</h2>
              <p className="stat-value">{data.totals.orders}</p>
              <Change now={data.totals.orders} before={data.previous.orders} days={days} />
            </div>
            <div className="panel stat">
              <h2>Average order</h2>
              <p className="stat-value">{formatPrice(data.totals.averageOrder)}</p>
              <p className="stat-change muted">{data.totals.itemsSold} items sold</p>
            </div>
            <div className="panel stat">
              <h2>Discounts given</h2>
              <p className="stat-value">{formatPrice(data.totals.discount)}</p>
              <p className="stat-change muted">
                {data.totals.cancelled} {data.totals.cancelled === 1 ? 'order' : 'orders'} cancelled
              </p>
            </div>
          </section>

          <section className="panel" aria-labelledby="revenue-per-day">
            <h2 id="revenue-per-day">Revenue per day</h2>
            <RevenueChart daily={data.daily} />
          </section>

          <div className="admin-columns">
            <section className="panel" aria-labelledby="best-sellers">
              <h2 id="best-sellers">Best sellers</h2>
              {data.bestSellers.length === 0 ? (
                <p className="muted">No sales in this period.</p>
              ) : (
                <div className="table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th className="num">Sold</th>
                        <th className="num">Sales</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.bestSellers.map((b) => (
                        <tr key={b.productId}>
                          <td>{b.slug ? <Link to={`/p/${b.slug}`}>{b.title}</Link> : b.title}</td>
                          <td className="num">{b.qty}</td>
                          <td className="num">{formatPrice(b.sales)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="muted small">
                Sold is less any items returned; sales are item prices before discounts and delivery.
              </p>
            </section>

            <section className="panel" aria-labelledby="needs-attention">
              <h2 id="needs-attention">Needs attention</h2>
              <p>
                {data.toShip === 0 ? (
                  'No orders waiting to be shipped.'
                ) : (
                  <Link to="/admin/orders?status=placed">
                    {data.toShip} {data.toShip === 1 ? 'order' : 'orders'} to ship
                  </Link>
                )}
              </p>
              {data.questionsToAnswer > 0 && (
                <p>
                  <Link to="/admin/questions">
                    {data.questionsToAnswer} {data.questionsToAnswer === 1 ? 'question' : 'questions'} to answer
                  </Link>
                </p>
              )}
              <h3>Low stock</h3>
              {data.lowStock.length === 0 ? (
                <p className="muted">Every product in the store has more than 5 left.</p>
              ) : (
                <div className="table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th className="num">Left</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.lowStock.map((p) => (
                        <tr key={p.id}>
                          <td>
                            <Link to={`/admin/products/${p.id}`}>{p.title}</Link>
                            {p.variants.length > 0 && (
                              <span className="muted small block">
                                {p.variants
                                  .map((v) => `${v.label}: ${v.stock === 0 ? 'sold out' : `${v.stock} left`}`)
                                  .join(' · ')}
                              </span>
                            )}
                          </td>
                          <td className="num">
                            {p.stock === 0 ? <span className="status cancelled">Sold out</span> : p.stock}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="muted small">
                Products in the store with 5 or fewer left.
                {data.lowStockCount > data.lowStock.length && (
                  <>
                    {' '}
                    Showing {data.lowStock.length} of {data.lowStockCount};{' '}
                    <Link to="/admin/products?status=low">see them all</Link>.
                  </>
                )}
              </p>
              <LowStockEmailSwitch enabled={data.lowStockEmail} />
            </section>
          </div>

          <ExportOrders key={days} from={data.daily[0].date} to={data.daily.at(-1).date} />
        </div>
      )}
    </div>
  );
}
