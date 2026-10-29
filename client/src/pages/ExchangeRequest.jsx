import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';
import { formatDate, smallImage } from '../format.js';
import { useFetch } from '../useFetch.js';
import NotFound from './NotFound.jsx';

// The same reasons as server/src/emails.js.
const REASONS = {
  fit: "Doesn't fit",
  look: 'Prefer another colour or style',
  other: 'Other',
};

// Asks to exchange items of a delivered order for another option of the same product at the same price
// (/orders/:id/exchange): which option instead, how many, why.
export default function ExchangeRequest() {
  const { id } = useParams();
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { data, error } = useFetch(user ? `/orders/${encodeURIComponent(id)}/exchanges` : null);
  // Per line (by index): { variantId, qty }; no variantId means keep it.
  const [choice, setChoice] = useState({});
  const [state, setState] = useState({ busy: false, error: null });

  if (user === undefined) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (error?.status === 404 || error?.status === 400) return <NotFound message="We couldn't find that order." />;
  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const back = <Link to={`/orders/${id}`}>← Back to the order</Link>;
  const lines = data.items.filter((i) => i.exchangeable > 0 && i.options.length > 0);
  if (!data.canExchange || lines.length === 0) {
    return (
      <div className="panel return-page">
        <h1>Exchange items</h1>
        <p>
          {data.canExchange
            ? 'None of the items in this order can be exchanged now: only items with sizes or colours can, for another one at the same price, once per item.'
            : 'Items can be exchanged for 7 days after the order is delivered.'}
        </p>
        {back}
      </div>
    );
  }

  const chosen = lines
    .filter((i) => choice[i.index]?.variantId)
    .map((i) => ({ index: i.index, variantId: choice[i.index].variantId, qty: choice[i.index].qty ?? 1 }));
  const set = (index, change) => setChoice({ ...choice, [index]: { ...choice[index], ...change } });

  async function submit(e) {
    e.preventDefault();
    const { reason, note } = Object.fromEntries(new FormData(e.currentTarget));
    if (!chosen.length) return setState({ busy: false, error: 'Choose what you would like instead' });
    setState({ busy: true, error: null });
    try {
      await request(`/orders/${id}/exchanges`, { method: 'POST', body: { items: chosen, reason, note } });
      navigate(`/orders/${id}`, { state: { exchangeRequested: true } });
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <form className="panel return-page" onSubmit={submit} aria-labelledby="exchange-heading">
      {back}
      <h1 id="exchange-heading">Exchange items</h1>
      <p className="muted small">
        Swap an item for another size or colour at the same price. You can ask until{' '}
        {formatDate(data.exchangeableUntil)}. We set your new choice aside straight away and send it once your item is
        back with us. An exchanged item can&rsquo;t be returned afterwards.
      </p>
      <ul className="return-items">
        {lines.map((i) => (
          <li key={i.index} className="exchange-line">
            {i.image && <img src={smallImage(i.image)} alt="" width="56" height="56" />}
            <span className="return-title">{i.title}</span>
            <span className="exchange-choice">
              <label>
                Instead
                <select
                  value={choice[i.index]?.variantId ?? ''}
                  onChange={(e) => set(i.index, { variantId: e.target.value })}
                  aria-label={`What you'd like instead of ${i.title}`}
                >
                  <option value="">Keep this one</option>
                  {i.options.map((o) => (
                    <option key={o.id} value={o.id} disabled={o.stock === 0}>
                      {o.label}
                      {o.stock === 0 ? ' (sold out)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              {i.exchangeable > 1 && choice[i.index]?.variantId && (
                <label>
                  How many
                  <select
                    value={choice[i.index]?.qty ?? 1}
                    onChange={(e) => set(i.index, { qty: Number(e.target.value) })}
                    aria-label={`How many of ${i.title} to exchange`}
                  >
                    {Array.from({ length: i.exchangeable }, (_, n) => (
                      <option key={n + 1} value={n + 1}>
                        {n + 1}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </span>
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
      <p className="muted small">
        Wrong item, or arrived damaged? <Link to={`/orders/${id}/return`}>Return it</Link> instead. For another price,
        return it and order the one you want.
      </p>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" className="btn primary" disabled={state.busy || !chosen.length}>
        Ask to exchange
      </button>
    </form>
  );
}
