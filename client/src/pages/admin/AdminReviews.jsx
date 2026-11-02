import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { query, request } from '../../api.js';
import Pager from '../../components/Pager.jsx';
import Stars from '../../components/Stars.jsx';
import { ReviewPhotos } from '../../components/Reviews.jsx';
import ScreeningFlag from '../../components/ScreeningFlag.jsx';
import { formatDate, formatPrice } from '../../format.js';
import { useFetch } from '../../useFetch.js';

const FILTERS = [
  ['', 'All'],
  ['visible', 'Visible'],
  ['hidden', 'Hidden'],
  ['flagged', 'Flagged'],
  ['reply', 'Needs a reply'],
];

// The store's public reply to a review (stage 148): shown on the product page as "Reply from Bazaar"; the reviewer is
// emailed the first time. A form per review, opened from its <summary>.
function ReplyBox({ review, onChange }) {
  const [state, setState] = useState({ busy: false, error: null });
  const reply = review.reply;
  const who = review.customer?.name ?? review.author;

  async function run(change) {
    setState({ busy: true, error: null });
    try {
      await change();
      setState({ busy: false, error: null });
      onChange();
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }
  const save = (e) => {
    e.preventDefault();
    const text = new FormData(e.currentTarget).get('reply');
    run(() => request(`/admin/reviews/${review.id}/reply`, { method: 'PUT', body: { text } }));
  };
  const remove = () =>
    window.confirm('Remove this reply from the product page?') &&
    run(() => request(`/admin/reviews/${review.id}/reply`, { method: 'DELETE' }));

  return (
    <div className="admin-reply">
      {reply && (
        <div className="review-reply">
          <p className="small">
            <strong>Your reply</strong>{' '}
            <span className="muted">
              {reply.by ? `by ${reply.by}, ` : ''}
              {formatDate(reply.updatedAt)}
            </span>
          </p>
          <p className="review-body">{reply.text}</p>
          {reply.reviewEditedSince && <p className="small muted">The customer has edited their review since.</p>}
        </div>
      )}
      <details>
        <summary className="small">{reply ? 'Edit reply' : 'Reply'}</summary>
        <form key={reply?.updatedAt ?? 'new'} onSubmit={save} aria-label={`Reply to ${who}'s review`}>
          <label className="sr-only" htmlFor={`reply-${review.id}`}>
            Reply to {who}
          </label>
          <textarea
            id={`reply-${review.id}`}
            name="reply"
            rows="3"
            maxLength="1000"
            required
            defaultValue={reply?.text ?? ''}
          />
          <p className="muted small">
            Shown under the review as &ldquo;Reply from Bazaar&rdquo;.
            {!reply && ' The customer is emailed it.'}
          </p>
          {state.error && (
            <p className="error small" role="alert">
              {state.error}
            </p>
          )}
          <div className="notice-actions">
            <button type="submit" className="btn small primary" disabled={state.busy}>
              Save reply
            </button>
            {reply && (
              <button type="button" className="btn small" disabled={state.busy} onClick={remove}>
                Remove reply
              </button>
            )}
          </div>
        </form>
      </details>
    </div>
  );
}

// "What customers say" on product pages (stage 60), on or off for the whole store. Shown only when the server has an
// API key. Saved as soon as it's ticked; back as it was if that fails.
function ReviewSummariesSwitch() {
  const { data } = useFetch('/admin/review-summaries');
  const [state, setState] = useState({ on: null, busy: false, error: null });
  if (!data?.available) return null;
  const on = state.on ?? data.enabled;

  async function change(enabled) {
    setState({ on: enabled, busy: true, error: null });
    try {
      await request('/admin/review-summaries', { method: 'PUT', body: { enabled } });
      setState({ on: enabled, busy: false, error: null });
    } catch (err) {
      setState({ on: !enabled, busy: false, error: err.message });
    }
  }

  return (
    <>
      <label className="check">
        <input type="checkbox" checked={on} disabled={state.busy} onChange={(e) => change(e.target.checked)} />
        Show &ldquo;What customers say&rdquo; on product pages
      </label>
      <p className="muted small">
        Claude summarises a product&apos;s shown reviews once it has three with words, and again a few minutes after
        they change. The summary is labelled as written by AI; hiding a review takes it out.
      </p>
      {state.error && <p className="error small">{state.error}</p>}
    </>
  );
}

// Review rewards (stage 145): store credit for a review with a photo and some words, once it has been shown a few
// days. Off until switched on; only reviews written from then count.
function ReviewRewards() {
  const [version, setVersion] = useState(0);
  const { data } = useFetch('/admin/review-rewards', version);
  const [state, setState] = useState({ busy: false, error: null, done: null });
  if (!data) return null;
  async function save(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null, done: null });
    try {
      await request('/admin/review-rewards', {
        method: 'PUT',
        body: {
          enabled: f.enabled === 'on',
          amount: Math.round(Number(f.amount) * 100),
          minChars: Number(f.minChars),
          monthlyCap: Number(f.monthlyCap),
        },
      });
      setState({ busy: false, error: null, done: 'Saved.' });
      setVersion((v) => v + 1);
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
    }
  }
  return (
    <details className="panel review-rewards">
      <summary>Review rewards: {data.enabled ? `on, ${formatPrice(data.amount)} a review` : 'off'}</summary>
      <form key={JSON.stringify(data)} onSubmit={save} aria-labelledby="review-rewards-heading">
        <h2 id="review-rewards-heading" className="sr-only">
          Review rewards
        </h2>
        <p className="muted small">
          Store credit for a review with at least one photo and some words, paid once it has been shown for 3 days (and,
          when screening is on, wasn&apos;t flagged). Once per customer and product; only reviews written after you
          switch it on count. Paid so far: {formatPrice(data.paid.total)} for {data.paid.count}{' '}
          {data.paid.count === 1 ? 'review' : 'reviews'}.
        </p>
        <label className="check">
          <input name="enabled" type="checkbox" defaultChecked={data.enabled} />
          Give review rewards
        </label>
        <div className="address-grid">
          <label>
            Credit per review (₹)
            <input name="amount" type="number" min="1" max="500" step="1" required defaultValue={data.amount / 100} />
          </label>
          <label>
            At least this many characters
            <input name="minChars" type="number" min="0" max="1000" step="1" required defaultValue={data.minChars} />
          </label>
          <label>
            Most rewards per customer a month
            <input name="monthlyCap" type="number" min="1" max="50" step="1" required defaultValue={data.monthlyCap} />
          </label>
        </div>
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        {state.done && <p role="status">{state.done}</p>}
        <button type="submit" className="btn primary" disabled={state.busy}>
          Save review rewards
        </button>
      </form>
    </details>
  );
}

export default function AdminReviews() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState(null);
  const {
    data,
    error: loadError,
    loading,
  } = useFetch(`/admin/reviews${query({ status, page: page > 1 ? page : '' })}`, version);

  const update = (changes) => {
    const next = { status, ...changes };
    setParams(query({ ...next, page: changes.page > 1 ? changes.page : '' }).slice(1));
  };

  async function setHidden(review, hidden) {
    setError(null);
    try {
      await request(`/admin/reviews/${review.id}/visibility`, { method: 'POST', body: { hidden } });
      setVersion((v) => v + 1);
    } catch (err) {
      setError(err.message);
    }
  }

  const counts = data && { '': data.counts.visible + data.counts.hidden, ...data.counts };

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Reviews</h1>
      </div>
      <p className="muted small">
        Hiding a review removes it from the product page and its rating. Nothing is deleted. When the writing assistant
        is on, new reviews are checked for abuse, spam and personal details, and doubtful ones are listed under Flagged
        (never hidden for you). Shown reviews of 1 or 2 stars without a reply are under Needs a reply, and admins are
        emailed about each new one.
      </p>
      <ReviewSummariesSwitch />
      <ReviewRewards />

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
            {counts && <span className="count">{counts[value]}</span>}
          </button>
        ))}
      </div>

      {(error || loadError) && <p className="error">{error ?? loadError.message}</p>}
      {data?.items.length === 0 && (
        <p className="muted">
          {status === 'flagged'
            ? 'Nothing flagged. Every checked review looks fine.'
            : status === 'reply'
              ? 'Every shown 1 or 2 star review has a reply.'
              : 'No reviews here yet.'}
        </p>
      )}
      {data?.items.length > 0 && (
        <div className={`table-wrap ${loading ? 'stale' : ''}`}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Review</th>
                <th>Product</th>
                <th>Customer</th>
                <th>Date</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id} className={r.hidden ? 'inactive' : ''}>
                  <td className="review-cell">
                    <Stars rating={r.rating} />
                    {r.title && <strong className="block">{r.title}</strong>}
                    {r.body && <span className="review-excerpt">{r.body}</span>}
                    <ReviewPhotos review={r} />
                    <ScreeningFlag kind="review" post={r} onChange={() => setVersion((v) => v + 1)} />
                    <ReplyBox review={r} onChange={() => setVersion((v) => v + 1)} />
                  </td>
                  <td>
                    {r.product ? <Link to={`/p/${r.product.slug}`}>{r.product.title}</Link> : 'Deleted product'}
                    {r.product && !r.product.active && <span className="muted small block">Hidden product</span>}
                  </td>
                  <td>
                    {r.customer?.name ?? 'Deleted account'}
                    <span className="muted small block">{r.customer?.email}</span>
                  </td>
                  <td>{formatDate(r.createdAt)}</td>
                  <td>
                    <div className="status-cell">
                      <span className={`status ${r.hidden ? 'cancelled' : 'placed'}`}>
                        {r.hidden ? 'Hidden' : 'Visible'}
                      </span>
                      <button type="button" className="link" onClick={() => setHidden(r, !r.hidden)}>
                        {r.hidden ? 'Show' : 'Hide'}
                        <span className="sr-only"> review by {r.customer?.name ?? r.author}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={(n) => update({ page: n })} />}
    </section>
  );
}
