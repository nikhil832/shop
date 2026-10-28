import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';
import { formatDate, formatPrice, smallImage } from '../format.js';
import { useFetch } from '../useFetch.js';
import NotFound from './NotFound.jsx';

const REASONS = {
  damaged: 'Arrived damaged or faulty',
  wrong_item: 'Wrong item sent',
  not_as_described: "Doesn't match the description",
  changed_mind: 'Changed my mind',
  other: 'Other',
};

// Asks to return some items of a delivered order (/orders/:id/return): how many of each, why, and a note.
export default function ReturnRequest() {
  const { id } = useParams();
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { data, error } = useFetch(user ? `/orders/${encodeURIComponent(id)}/returns` : null);
  // How many of each line (by index) to return.
  const [qty, setQty] = useState({});
  const [state, setState] = useState({ busy: false, error: null });

  if (user === undefined) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (error?.status === 404 || error?.status === 400) return <NotFound message="We couldn't find that order." />;
  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const back = <Link to={`/orders/${id}`}>← Back to the order</Link>;
  const returnable = data.items.filter((i) => i.returnable > 0);
  if (!data.canReturn || returnable.length === 0) {
    return (
      <div className="panel return-page">
        <h1>Return items</h1>
        <p>
          {data.canReturn
            ? 'Every item of this order is already being returned.'
            : 'Items can be returned for 7 days after the order is delivered.'}
        </p>
        {back}
      </div>
    );
  }

  const chosen = returnable.filter((i) => qty[i.index] > 0).map((i) => ({ index: i.index, qty: qty[i.index] }));
  const value = chosen.reduce((sum, c) => sum + data.items[c.index].price * c.qty, 0);

  async function submit(e) {
    e.preventDefault();
    const { reason, note, refundTo } = Object.fromEntries(new FormData(e.currentTarget));
    if (!chosen.length) return setState({ busy: false, error: 'Choose at least one item to return' });
    setState({ busy: true, error: null });
    try {
      await request(`/orders/${id}/returns`, { method: 'POST', body: { items: chosen, reason, note, refundTo } });
      navigate(`/orders/${id}`, { state: { returnRequested: true } });
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <form className="panel return-page" onSubmit={submit} aria-labelledby="return-heading">
      {back}
      <h1 id="return-heading">Return items</h1>
      <p className="muted small">
        You can ask until {formatDate(data.returnableUntil)}. We&rsquo;ll email you once we&rsquo;ve looked at it.
      </p>
      <ul className="return-items">
        {returnable.map((i) => (
          <li key={i.index}>
            {i.image && <img src={smallImage(i.image)} alt="" width="56" height="56" />}
            <span className="return-title">
              {i.title}
              <span className="muted small block">{formatPrice(i.price)} each</span>
            </span>
            <label>
              Return
              <select
                value={qty[i.index] ?? 0}
                onChange={(e) => setQty({ ...qty, [i.index]: Number(e.target.value) })}
                aria-label={`How many of ${i.title} to return`}
              >
                {Array.from({ length: i.returnable + 1 }, (_, n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </li>
        ))}
      </ul>
      <label>
        Reason
        <select name="reason" required defaultValue="">
          <option value="" disabled>
            Choose…
          </option>
          {Object.entries(REASONS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Anything we should know? (optional)
        <textarea name="note" rows="3" maxLength={500} />
      </label>
      <p>
        Items chosen: <strong>{formatPrice(value)}</strong>
        <span className="muted small block">
          The refund is this, less the items&rsquo; share of any coupon; delivery isn&rsquo;t refunded.
        </span>
      </p>
      <fieldset className="payment-options">
        <legend>Refund to</legend>
        <label className="payment-option">
          <input type="radio" name="refundTo" value="credit" />
          <span>
            <strong>Store credit</strong>
            <span className="muted small block">
              In your account as soon as we accept the return, for your next order. It doesn&rsquo;t expire.
            </span>
          </span>
        </label>
        <label className="payment-option">
          <input type="radio" name="refundTo" value="money" defaultChecked />
          <span>
            <strong>The way you paid</strong>
            <span className="muted small block">
              Online payments go back to your card or UPI in 5–7 working days; for Cash on Delivery we refund you
              directly. Any part you paid with store credit comes back as credit.
            </span>
          </span>
        </label>
      </fieldset>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" className="btn primary" disabled={state.busy || !chosen.length}>
        Ask to return
      </button>
    </form>
  );
}
