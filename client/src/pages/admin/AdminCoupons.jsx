import { useState } from 'react';
import { request } from '../../api.js';
import { formatDate, formatPrice, toPaise } from '../../format.js';
import { useFetch } from '../../useFetch.js';

export const describeCoupon = (c) =>
  c.type === 'free_delivery'
    ? 'Free delivery'
    : c.type === 'percent'
      ? `${c.value}% off${c.maxDiscount ? ` (up to ${formatPrice(c.maxDiscount)})` : ''}`
      : `${formatPrice(c.value)} off`;

const conditions = (c) =>
  [
    c.minSubtotal > 0 && `Orders from ${formatPrice(c.minSubtotal)}`,
    c.expiresAt && `${new Date(c.expiresAt) <= new Date() ? 'Ended' : 'Ends'} ${formatDate(c.expiresAt)}`,
  ]
    .filter(Boolean)
    .join(' · ') || '—';

// The form's rupee and date fields, turned into what the API takes (paise, an end-of-day date, numbers or null).
function couponBody(form) {
  const f = Object.fromEntries(new FormData(form));
  const optional = (value, convert) => (value === '' || value === undefined ? null : convert(value));
  return {
    code: f.code,
    type: f.type,
    value: f.type === 'percent' ? Number(f.value) : f.type === 'flat' ? toPaise(f.value) : 0,
    maxDiscount: f.type === 'percent' ? optional(f.maxDiscount, toPaise) : null,
    minSubtotal: optional(f.minSubtotal, toPaise) ?? 0,
    // The last day it works: until the end of that day, local time.
    expiresAt: optional(f.expiresAt, (d) => new Date(`${d}T23:59:59`).toISOString()),
    usageLimit: optional(f.usageLimit, Number),
  };
}

// Cashback (stage 85): store credit for orders kept past their return window. Off until switched on; only orders
// placed from then earn it.
function Cashback() {
  const [version, setVersion] = useState(0);
  const { data } = useFetch('/admin/cashback', version);
  const [state, setState] = useState({ busy: false, error: null, done: null });
  if (!data) return null;
  async function save(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null, done: null });
    try {
      await request('/admin/cashback', {
        method: 'PUT',
        body: { enabled: f.enabled === 'on', percent: Number(f.percent), cap: Math.round(Number(f.cap) * 100) },
      });
      setState({ busy: false, error: null, done: 'Saved.' });
      setVersion((v) => v + 1);
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
    }
  }
  return (
    <form key={JSON.stringify(data)} className="panel" onSubmit={save} aria-labelledby="cashback-heading">
      <h2 id="cashback-heading">Cashback</h2>
      <p className="muted small">
        A percentage of what each delivered order paid for the items kept comes back as store credit once its 7-day
        return window has passed. Only orders placed after it&apos;s switched on earn it.
        {data.since && ` On since ${new Date(data.since).toLocaleDateString('en-IN')}.`} Paid so far:{' '}
        {formatPrice(data.paid.total)} on {data.paid.orders} {data.paid.orders === 1 ? 'order' : 'orders'}.
      </p>
      <label className="check">
        <input name="enabled" type="checkbox" defaultChecked={data.enabled} />
        Give cashback
      </label>
      <div className="address-grid">
        <label>
          Percent back
          <input name="percent" type="number" min="1" max="20" step="1" required defaultValue={data.percent} />
        </label>
        <label>
          At most per order (₹)
          <input name="cap" type="number" min="1" step="1" required defaultValue={data.cap / 100} />
        </label>
      </div>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && <p role="status">{state.done}</p>}
      <button type="submit" className="btn primary" disabled={state.busy}>
        Save cashback
      </button>
    </form>
  );
}

export default function AdminCoupons() {
  const [version, setVersion] = useState(0);
  const { data: coupons, error } = useFetch('/admin/coupons', version);
  const [state, setState] = useState({ busy: false, error: null });
  const [type, setType] = useState('percent');

  async function run(change) {
    setState({ busy: true, error: null });
    try {
      await change();
      setState({ busy: false, error: null });
      setVersion((v) => v + 1);
      return true;
    } catch (err) {
      setState({ busy: false, error: err.message });
      return false;
    }
  }

  async function create(e) {
    e.preventDefault();
    const form = e.currentTarget;
    if (await run(() => request('/admin/coupons', { method: 'POST', body: couponBody(form) }))) {
      form.reset();
      setType('percent');
    }
  }

  const setActive = (c, active) => run(() => request(`/admin/coupons/${c.id}`, { method: 'PATCH', body: { active } }));

  return (
    <div className="admin-form">
      <section className="panel">
        <div className="admin-head">
          <h1>Coupons</h1>
        </div>
        <p className="muted small">
          Each customer can use a coupon once; cancelling the order gives the use back. Coupons can be switched off but
          not deleted, because orders refer to them.
        </p>
        {(state.error || error) && (
          <p className="error" role="alert">
            {state.error ?? error.message}
          </p>
        )}
        {coupons?.length === 0 && <p className="muted">No coupons yet. Create one below.</p>}
        {coupons?.length > 0 && (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Discount</th>
                  <th>Conditions</th>
                  <th>Used</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {coupons.map((c) => (
                  <tr key={c.id} className={c.active ? '' : 'inactive'}>
                    <td>
                      <strong>{c.code}</strong>
                    </td>
                    <td>{describeCoupon(c)}</td>
                    <td>{conditions(c)}</td>
                    <td>
                      {c.usedCount}
                      {c.usageLimit ? ` / ${c.usageLimit}` : ''}
                    </td>
                    <td>
                      <div className="status-cell">
                        <span className={`status ${c.active ? 'placed' : 'cancelled'}`}>{c.active ? 'On' : 'Off'}</span>
                        <button
                          type="button"
                          className="link"
                          onClick={() => setActive(c, !c.active)}
                          disabled={state.busy}
                        >
                          {c.active ? 'Switch off' : 'Switch on'}
                          <span className="sr-only"> {c.code}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <form className="panel admin-form" onSubmit={create} aria-labelledby="new-coupon">
        <h2 id="new-coupon">New coupon</h2>
        <div className="address-grid">
          <label>
            Code
            <input name="code" required pattern="[A-Za-z0-9]{3,20}" title="3–20 letters and digits" maxLength={20} />
          </label>
          <label>
            Discount
            <select name="type" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="percent">Percentage off</option>
              <option value="flat">Amount off</option>
              <option value="free_delivery">Free delivery</option>
            </select>
          </label>
          {type === 'percent' && (
            <>
              <label>
                Percent off
                <input name="value" type="number" required min={1} max={90} step={1} />
              </label>
              <label>
                Maximum discount, ₹ (optional)
                <input name="maxDiscount" type="number" min={1} step={1} />
              </label>
            </>
          )}
          {type === 'flat' && (
            <label>
              Amount off, ₹
              <input name="value" type="number" required min={1} step={1} />
            </label>
          )}
          <label>
            Minimum order, ₹ (optional)
            <input name="minSubtotal" type="number" min={0} step="any" />
          </label>
          <label>
            Last day (optional)
            <input name="expiresAt" type="date" />
          </label>
          <label>
            Total uses (optional)
            <input name="usageLimit" type="number" min={1} step={1} />
          </label>
        </div>
        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={state.busy}>
            Create coupon
          </button>
        </div>
      </form>
      <Cashback />
    </div>
  );
}
