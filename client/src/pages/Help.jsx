import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';
import { HELP_STATUS, HELP_TOPICS, formatDate, orderNumber } from '../format.js';
import { useFetch } from '../useFetch.js';

// "Contact us" (stage 64): a form for anyone, and for logged-in customers their own requests. `?order=<id>` (from
// "Get help with this order") asks about that order.
export default function Help() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const orderId = user ? params.get('order') : null;
  const [state, setState] = useState({ busy: false, error: null, sentTo: null });
  const { data: mine } = useFetch(user ? '/help' : null);
  const { data: order } = useFetch(orderId ? `/orders/${orderId}` : null);

  if (user === undefined) return <p className="muted">Loading…</p>;

  async function submit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const fields = Object.fromEntries(new FormData(form));
    setState({ busy: true, error: null, sentTo: null });
    try {
      const created = await request('/help', {
        method: 'POST',
        body: { ...fields, ...(orderId && { orderId, topic: 'order' }) },
      });
      if (user) return navigate(`/help/${created.id}`, { state: { sent: true } });
      form.reset();
      setState({ busy: false, error: null, sentTo: fields.email });
    } catch (err) {
      setState({ busy: false, error: err.message, sentTo: null });
    }
  }

  return (
    <div className="orders-page help-page">
      <section className="panel account-section" aria-labelledby="help-heading">
        <h1 id="help-heading">{orderId ? `Help with order #${order ? orderNumber(order) : '…'}` : 'Contact us'}</h1>
        {state.sentTo ? (
          <p role="status">
            Thanks: we&apos;ve got your message and will reply to {state.sentTo}, usually within a working day.
          </p>
        ) : (
          <form className="help-form" onSubmit={submit}>
            <p className="muted small">
              {user
                ? 'We usually reply within a working day, by email and here.'
                : 'We usually reply within a working day, by email.'}{' '}
              Please don&apos;t send card or bank details.
            </p>
            {!user && (
              <>
                <label>
                  Your name
                  <input name="name" required maxLength={80} autoComplete="name" />
                </label>
                <label>
                  Your email
                  <input name="email" type="email" required maxLength={254} autoComplete="email" />
                </label>
              </>
            )}
            {!orderId && (
              <label>
                What is it about?
                <select name="topic" required defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  {Object.entries(HELP_TOPICS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Your message
              <textarea name="message" required minLength={5} maxLength={2000} rows={5} />
            </label>
            {!user && (
              <p className="muted small">
                Asking about an order? <Link to="/login?next=%2Forders">Log in</Link> and use &ldquo;Get help with this
                order&rdquo; on it.
              </p>
            )}
            {state.error && (
              <p className="error" role="alert">
                {state.error}
              </p>
            )}
            <button type="submit" className="btn primary" disabled={state.busy}>
              {state.busy ? 'Sending…' : 'Send'}
            </button>
          </form>
        )}
      </section>

      {mine?.items.length > 0 && (
        <section className="panel account-section" aria-labelledby="mine-heading">
          <h2 id="mine-heading">Your requests</h2>
          <ul className="help-list">
            {mine.items.map((r) => (
              <li key={r.id}>
                <Link to={`/help/${r.id}`}>
                  Request #{r.number}: {HELP_TOPICS[r.topic]}
                </Link>
                <span className={`status help-${r.status}`}>{HELP_STATUS[r.status]}</span>
                <span className="muted small">{formatDate(r.updatedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
