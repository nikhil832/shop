import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { query, request } from '../../api.js';
import Pager from '../../components/Pager.jsx';
import Stars from '../../components/Stars.jsx';
import { ReviewPhotos } from '../../components/Reviews.jsx';
import ScreeningFlag from '../../components/ScreeningFlag.jsx';
import { formatDate } from '../../format.js';
import { useFetch } from '../../useFetch.js';

const FILTERS = [
  ['', 'All'],
  ['visible', 'Visible'],
  ['hidden', 'Hidden'],
  ['flagged', 'Flagged'],
];

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
        (never hidden for you).
      </p>
      <ReviewSummariesSwitch />

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
          {status === 'flagged' ? 'Nothing flagged. Every checked review looks fine.' : 'No reviews here yet.'}
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
