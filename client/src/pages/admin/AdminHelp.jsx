import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { query, request } from '../../api.js';
import Pager from '../../components/Pager.jsx';
import { useAuth } from '../../auth.jsx';
import { can } from '../../permissions.js';
import { HELP_STATUS, HELP_TOPICS, formatDate, formatPrice, formatTime } from '../../format.js';
import { useFetch } from '../../useFetch.js';
import CustomerTags from '../../components/CustomerTags.jsx';

const FILTERS = [
  ['waiting', 'Waiting'],
  ['answered', 'Answered'],
  ['closed', 'Closed'],
];

// Store credit for a customer (stage 72, admins only): their balance, and goodwill to add (or a minus amount to take
// back a mistake). `path` is the pair of routes (GET the balance, POST the credit): a help request's or a customer's
// (Admin → Customers). On help cards it's mounted when opened, so the inbox doesn't ask for every card's balance.
export function CreditBox({ path, name, onChange }) {
  const [version, setVersion] = useState(0);
  const { data } = useFetch(path, version);
  const [state, setState] = useState({ busy: false, error: null, done: null });
  const [formKey, setFormKey] = useState(0);

  async function submit(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    const amount = Math.round(Number(f.amount) * 100);
    setState({ busy: true, error: null, done: null });
    try {
      const res = await request(path, { method: 'POST', body: { amount, note: f.note } });
      setState({
        busy: false,
        error: null,
        done: `${amount > 0 ? 'Added' : 'Took back'} ${formatPrice(Math.abs(amount))}. ${name} now has ${formatPrice(res.balance)}.`,
      });
      setFormKey((k) => k + 1);
      setVersion((v) => v + 1);
      onChange?.();
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
    }
  }

  return (
    <form key={formKey} className="review-form" onSubmit={submit}>
      <p className="small">
        {data ? `${name} has ${formatPrice(data.balance)} of store credit.` : 'Loading…'} It&apos;s spent at checkout
        and never expires.
      </p>
      <div className="address-grid">
        <label>
          Amount (₹)
          <input name="amount" type="number" step="1" min="-10000" max="10000" required />
        </label>
        <label>
          Why (the customer sees this)
          <input name="note" minLength={3} maxLength={200} required placeholder="Sorry about the late delivery" />
        </label>
      </div>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && <p role="status">{state.done}</p>}
      <div className="form-actions">
        <button type="submit" className="btn small" disabled={state.busy}>
          Give credit
        </button>
        <span className="muted small">They&apos;re emailed. A minus amount takes credit back.</span>
      </div>
    </form>
  );
}

// One help request: who, about what (and which order), the conversation, a reply box, and close/reopen.
function RequestCard({ item, onChange }) {
  const { user } = useAuth();
  const [state, setState] = useState({ busy: false, error: null });
  const [creditOpen, setCreditOpen] = useState(false);
  const r = item;

  async function send(path, body) {
    setState({ busy: true, error: null });
    try {
      await request(path, { method: 'POST', body });
      setState({ busy: false, error: null });
      onChange();
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <li className="panel question-card">
      <div className="muted small">
        Request #{r.number} · {HELP_TOPICS[r.topic]} ·{' '}
        {r.customer.id && can(user, '*') ? (
          <Link to={`/admin/customers/${r.customer.id}`}>{r.customer.name}</Link>
        ) : (
          r.customer.name
        )}{' '}
        <CustomerTags tags={r.customer.tags} /> ({r.customer.email}){r.customer.guest && ' · not logged in'}
        {r.orderId && (
          <>
            {' '}
            · <Link to={`/admin/orders/${r.orderId}`}>Order #{r.orderNumber}</Link>
          </>
        )}
      </div>
      <ol className="help-thread">
        {r.messages.map((m, i) => (
          <li key={i} className={`help-message ${m.from}`}>
            <span className="muted small">
              {m.from === 'store' ? m.by : r.customer.name} · {formatDate(m.at)}, {formatTime(m.at)}
            </span>
            <p>{m.text}</p>
          </li>
        ))}
      </ol>
      <form
        className="review-form"
        onSubmit={(e) => {
          e.preventDefault();
          send(`/admin/help/${r.id}/reply`, { text: new FormData(e.currentTarget).get('text') });
        }}
      >
        <label>
          Reply to {r.customer.name}
          <textarea name="text" rows={3} minLength={5} maxLength={2000} required />
        </label>
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="btn primary small" disabled={state.busy}>
            Send reply
          </button>
          <button
            type="button"
            className="btn small"
            disabled={state.busy}
            onClick={() => send(`/admin/help/${r.id}/status`, { status: r.status === 'closed' ? 'open' : 'closed' })}
          >
            {r.status === 'closed' ? 'Reopen' : 'Close'}
            <span className="sr-only"> request #{r.number}</span>
          </button>
          <span className="muted small">The reply is emailed to them.</span>
        </div>
      </form>
      {can(user, '*') && !r.customer.guest && (
        <details className="credit-details" onToggle={(e) => setCreditOpen(e.currentTarget.open)}>
          <summary>
            Store credit<span className="sr-only"> for {r.customer.name}</span>
          </summary>
          {creditOpen && <CreditBox path={`/admin/help/${r.id}/credit`} name={r.customer.name} />}
        </details>
      )}
    </li>
  );
}

export default function AdminHelp() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'waiting';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [version, setVersion] = useState(0);
  const { data, error, loading } = useFetch(`/admin/help${query({ status, page: page > 1 ? page : '' })}`, version);

  const update = (changes) => {
    const next = { status, ...changes };
    setParams(
      query({ status: next.status === 'waiting' ? '' : next.status, page: changes.page > 1 ? changes.page : '' }).slice(
        1,
      ),
    );
  };

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Help requests</h1>
      </div>
      <p className="muted small">
        Customers&apos; messages from &ldquo;Contact us&rdquo; and &ldquo;Get help with this order&rdquo;. Replies are
        emailed to them (and shown on their Help page when they&apos;re logged in). Waiting ones are oldest first.
      </p>
      <div className="status-tabs" role="group" aria-label="Filter by status">
        {FILTERS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={value === status ? 'active' : ''}
            aria-pressed={value === status}
            onClick={() => update({ status: value })}
          >
            {label}
            {data && <span className="count">{data.counts[value]}</span>}
          </button>
        ))}
      </div>
      {error && <p className="error">{error.message}</p>}
      {data?.items.length === 0 && (
        <p className="muted">{status === 'waiting' ? 'Nobody is waiting for an answer.' : 'None here.'}</p>
      )}
      {data?.items.length > 0 && (
        <ul className={`question-list ${loading ? 'stale' : ''}`}>
          {data.items.map((r) => (
            <RequestCard
              key={`${r.id}:${r.messages.length}:${r.status}`}
              item={r}
              onChange={() => setVersion((v) => v + 1)}
            />
          ))}
        </ul>
      )}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={(p) => update({ page: p })} />}
    </section>
  );
}

// On an order's admin page: its help requests, if any, linking to the inbox.
export function OrderHelpRequests({ orderId }) {
  const { data } = useFetch(`/admin/help?orderId=${orderId}`);
  if (!data?.items.length) return null;
  return (
    <p className="small">
      Help requests about this order:{' '}
      {data.items.map((r, i) => (
        <span key={r.id}>
          {i > 0 && ', '}
          <Link to={`/admin/help?status=${r.status}`}>
            #{r.number} ({HELP_STATUS[r.status].toLowerCase()})
          </Link>
        </span>
      ))}
    </p>
  );
}
