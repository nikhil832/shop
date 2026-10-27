import { useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';
import { HELP_STATUS, HELP_TOPICS, formatDate, formatTime } from '../format.js';
import { useFetch } from '../useFetch.js';
import NotFound from './NotFound.jsx';

// One of the customer's help requests: the conversation with the store, and a box to write again.
export default function HelpRequest() {
  const { id } = useParams();
  const { user } = useAuth();
  const location = useLocation();
  const [version, setVersion] = useState(0);
  const [state, setState] = useState({ busy: false, error: null });
  const { data, error } = useFetch(user ? `/help/${id}` : null, version);

  if (user === undefined) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (error?.status === 404 || error?.status === 400) return <NotFound message="We couldn't find that request." />;
  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  async function send(e) {
    e.preventDefault();
    const form = e.currentTarget;
    setState({ busy: true, error: null });
    try {
      await request(`/help/${id}/messages`, { method: 'POST', body: { text: new FormData(form).get('text') } });
      form.reset();
      setState({ busy: false, error: null });
      setVersion((v) => v + 1);
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <div className="orders-page help-page">
      <p>
        <Link to="/help">← Contact us</Link>
      </p>
      <section className="panel account-section" aria-labelledby="request-heading">
        <h1 id="request-heading">
          Request #{data.number}: {HELP_TOPICS[data.topic]}
        </h1>
        <p>
          <span className={`status help-${data.status}`}>{HELP_STATUS[data.status]}</span>
          {data.orderId && (
            <>
              {' '}
              · <Link to={`/orders/${data.orderId}`}>The order</Link>
            </>
          )}
        </p>
        {location.state?.sent && data.messages.length === 1 && (
          <p role="status">Sent. We usually reply within a working day, by email and here.</p>
        )}
        <ol className="help-thread">
          {data.messages.map((m, i) => (
            <li key={i} className={`help-message ${m.from}`}>
              <span className="muted small">
                {m.from === 'store' ? `${m.by}, Bazaar` : 'You'} · {formatDate(m.at)}, {formatTime(m.at)}
              </span>
              <p>{m.text}</p>
            </li>
          ))}
        </ol>
        <form className="help-form" onSubmit={send}>
          <label>
            {data.status === 'closed' ? 'Write again (this opens the request again)' : 'Write again'}
            <textarea name="text" required minLength={5} maxLength={2000} rows={3} />
          </label>
          {state.error && (
            <p className="error" role="alert">
              {state.error}
            </p>
          )}
          <button type="submit" className="btn primary" disabled={state.busy}>
            {state.busy ? 'Sending…' : 'Send'}
          </button>
        </form>
      </section>
    </div>
  );
}
