import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { request } from '../api.js';
import { formatDate } from '../format.js';
import { uploadReviewPhoto } from '../photos.js';
import { useFetch } from '../useFetch.js';
import Pager from './Pager.jsx';
import Rating from './Rating.jsx';
import Stars from './Stars.jsx';

const MAX_PHOTOS = 3;

// The review's photos: thumbnails with Remove, and a picker that shrinks and uploads new ones straight away.
function PhotoPicker({ photos, onChange }) {
  const [state, setState] = useState({ uploading: 0, error: null });
  async function add(e) {
    const files = [...e.target.files].slice(0, MAX_PHOTOS - photos.length);
    e.target.value = ''; // the same file can be chosen again
    if (!files.length) return;
    setState({ uploading: files.length, error: null });
    const added = [];
    try {
      for (const file of files) added.push(await uploadReviewPhoto(file));
      setState({ uploading: 0, error: null });
    } catch (err) {
      setState({ uploading: 0, error: err.message });
    }
    if (added.length) onChange([...photos, ...added]);
  }
  return (
    <div className="photo-picker">
      <span className="photo-picker-label">
        Photos <span className="muted">(optional, up to {MAX_PHOTOS})</span>
      </span>
      {photos.length > 0 && (
        <ul className="review-photos">
          {photos.map((url, i) => (
            <li key={url}>
              <img src={url} alt={`Photo ${i + 1}`} width="72" height="72" />
              <button type="button" className="link" onClick={() => onChange(photos.filter((p) => p !== url))}>
                Remove<span className="sr-only"> photo {i + 1}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {photos.length < MAX_PHOTOS && (
        <label className="btn small photo-add">
          {state.uploading ? `Uploading ${state.uploading}…` : 'Add photos'}
          <input
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            onChange={add}
            disabled={state.uploading > 0}
          />
        </label>
      )}
      {state.error && <p className="error small">{state.error}</p>}
    </div>
  );
}

function ReviewForm({ slug, review, onSaved, onCancel }) {
  const [stars, setStars] = useState(review?.rating ?? 0);
  const [photos, setPhotos] = useState(review?.photos ?? []);
  const [state, setState] = useState({ busy: false, error: null });

  async function submit(e) {
    e.preventDefault();
    if (!stars) return setState({ busy: false, error: 'Choose 1 to 5 stars' });
    const form = new FormData(e.currentTarget);
    setState({ busy: true, error: null });
    try {
      await request(`/products/${slug}/review`, {
        method: 'PUT',
        body: { rating: stars, title: form.get('title'), body: form.get('body'), photos },
      });
      onSaved();
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <form className="panel review-form" onSubmit={submit}>
      <fieldset className="star-picker">
        <legend>Your rating</legend>
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className={n <= stars ? 'on' : ''}>
            <input
              type="radio"
              name="rating"
              value={n}
              checked={stars === n}
              onChange={() => setStars(n)}
              className="sr-only"
            />
            <span aria-hidden>★</span>
            <span className="sr-only">
              {n} {n === 1 ? 'star' : 'stars'}
            </span>
          </label>
        ))}
      </fieldset>
      <label>
        <span>
          Title <span className="muted">(optional)</span>
        </span>
        <input name="title" maxLength={100} defaultValue={review?.title} />
      </label>
      <label>
        <span>
          Review <span className="muted">(optional)</span>
        </span>
        <textarea name="body" rows={4} maxLength={2000} defaultValue={review?.body} />
      </label>
      <PhotoPicker photos={photos} onChange={setPhotos} />
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={state.busy}>
          {review ? 'Save review' : 'Post review'}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel} disabled={state.busy}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

// Thumbnails that open the full photo.
export function ReviewPhotos({ review }) {
  if (!review.photos?.length) return null;
  return (
    <ul className="review-photos">
      {review.photos.map((url, i) => (
        <li key={url}>
          <a href={url} target="_blank" rel="noreferrer">
            <img
              src={url}
              alt={`Photo ${i + 1} from ${review.author ? `${review.author}'s` : 'the'} review`}
              width="72"
              height="72"
              loading="lazy"
            />
          </a>
        </li>
      ))}
    </ul>
  );
}

function ReviewText({ review }) {
  return (
    <>
      <div className="review-head">
        <Stars rating={review.rating} />
        {review.title && <strong>{review.title}</strong>}
      </div>
      {review.body && <p className="review-body">{review.body}</p>}
      <ReviewPhotos review={review} />
    </>
  );
}

// What a logged-in visitor can do: write a review, or see, edit and delete their own.
function MyReview({ slug, viewer, onChange }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(null);
  const { review, canReview } = viewer;

  const saved = () => {
    setEditing(false);
    onChange();
  };

  async function remove() {
    if (!window.confirm('Delete your review?')) return;
    try {
      await request(`/products/${slug}/review`, { method: 'DELETE' });
      onChange();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!review && !canReview) {
    return <p className="muted">You can review this product once an order with it has been delivered to you.</p>;
  }
  if (!review) return <ReviewForm slug={slug} onSaved={onChange} />;
  if (editing) return <ReviewForm slug={slug} review={review} onSaved={saved} onCancel={() => setEditing(false)} />;
  return (
    <div className="panel my-review">
      <h3>Your review</h3>
      {review.hidden && <p className="problem">The store has hidden this review, so other customers don't see it.</p>}
      <ReviewText review={review} />
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="button" className="btn small" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button" className="btn small" onClick={remove}>
          Delete
        </button>
      </div>
    </div>
  );
}

// Stars per written review (bars), each a filter, plus "With photos" and the order. Pressing a pressed one shows
// all again. `breakdown` is { 1: n, …, 5: n } of the visible reviews, whatever the current filter.
// `shown`: how many reviews the current filter finds, announced to screen readers.
function ReviewFilters({ breakdown, withPhotos, shown, view, onView }) {
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const plural = (n) => `${n} ${n === 1 ? 'review' : 'reviews'}`;
  return (
    <div className="review-filters">
      <ul className="review-breakdown" aria-label="Filter by stars">
        {[5, 4, 3, 2, 1].map((n) => (
          <li key={n}>
            <button
              type="button"
              className="review-bar"
              aria-pressed={view.stars === n}
              disabled={!breakdown[n]}
              onClick={() => onView({ ...view, stars: view.stars === n ? null : n })}
            >
              <span>
                {n} <span aria-hidden="true">★</span>
                <span className="sr-only"> {n === 1 ? 'star' : 'stars'}:</span>
              </span>
              <span className="review-bar-track" aria-hidden="true">
                <span style={{ width: `${total ? (breakdown[n] / total) * 100 : 0}%` }} />
              </span>
              <span className="muted">{breakdown[n]}</span>
              <span className="sr-only">{breakdown[n] === 1 ? ' review' : ' reviews'}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="review-filter-row">
        {withPhotos > 0 && (
          <button
            type="button"
            className="btn small"
            aria-pressed={view.photos}
            onClick={() => onView({ ...view, photos: !view.photos })}
          >
            With photos ({withPhotos})
          </button>
        )}
        <label>
          Sort reviews
          <select value={view.sort} onChange={(e) => onView({ ...view, sort: e.target.value })}>
            <option value="newest">Newest first</option>
            <option value="helpful">Most helpful</option>
          </select>
        </label>
        <span className="sr-only" aria-live="polite">
          {view.stars || view.photos ? `Showing ${plural(shown)}` : ''}
        </span>
      </div>
    </div>
  );
}

// "Helpful" under someone else's review: a toggle for logged-in visitors, the count alone for others.
function HelpfulButton({ review, loggedIn, onVoted }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const count = review.helpful
    ? `${review.helpful} ${review.helpful === 1 ? 'person' : 'people'} found this helpful`
    : '';
  if (!loggedIn) return count && <span className="muted small">{count}</span>;
  async function vote() {
    setBusy(true);
    setError(null);
    try {
      const method = review.votedHelpful ? 'DELETE' : 'POST';
      onVoted(review.id, await request(`/reviews/${review.id}/helpful`, { method }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="review-helpful">
      <button type="button" className="btn small" aria-pressed={review.votedHelpful} disabled={busy} onClick={vote}>
        Helpful<span className="sr-only"> (review by {review.author})</span>
      </button>
      {count && <span className="muted small">{count}</span>}
      {error && <span className="error small">{error}</span>}
    </span>
  );
}

// Ratings & reviews under a product. `onChange` tells the page to reload the product, whose rating just changed.
// `canScroll`: the page's rows above have loaded, so a #reviews link can scroll here.
export default function Reviews({ product, canScroll, onChange }) {
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  // Which reviews are listed: the order, and a star or photos filter (stage 96).
  const [view, setView] = useState({ sort: 'newest', stars: null, photos: false });
  const query = new URLSearchParams({ page, sort: view.sort });
  if (view.stars) query.set('stars', view.stars);
  if (view.photos) query.set('photos', '1');
  const { data, error } = useFetch(`/products/${product.slug}/reviews?${query}`, version);
  // Helpful votes given on this page, over what the list loaded with (cleared when it reloads).
  const [voted, setVoted] = useState({ key: null, votes: {} });
  const listKey = `${version}:${query}`;
  const votes = voted.key === listKey ? voted.votes : {};
  const onVoted = (id, result) => setVoted({ key: listKey, votes: { ...votes, [id]: result } });
  const changeView = (next) => {
    setView(next);
    setPage(1);
  };
  const written = data ? Object.values(data.breakdown).reduce((a, b) => a + b, 0) : 0;
  const filtered = view.stars || view.photos;
  // Opened from the review reminder email (/p/…#reviews): scroll here once the reviews are in.
  const { hash } = useLocation();
  const loaded = Boolean(data) && canScroll;
  useEffect(() => {
    if (loaded && hash === '#reviews') document.getElementById('reviews')?.scrollIntoView();
  }, [loaded, hash]);

  const changed = () => {
    setPage(1);
    setVersion((v) => v + 1);
    onChange();
  };

  return (
    <section id="reviews" className="reviews" aria-labelledby="reviews-heading">
      <h2 id="reviews-heading">Ratings &amp; reviews</h2>
      <div className="reviews-summary">
        {product.rating.count ? (
          <>
            <Rating rating={product.rating} count={false} />
            <span className="muted">
              {product.rating.count.toLocaleString('en-IN')} {product.rating.count === 1 ? 'rating' : 'ratings'}
              {data && ` · ${written} written ${written === 1 ? 'review' : 'reviews'}`}
            </span>
          </>
        ) : (
          <span className="muted">No ratings yet.</span>
        )}
      </div>

      {data?.summary && (
        // "What customers say" (stage 60): written by AI from the visible reviews, and labelled so.
        <div className="review-ai-summary">
          <h3>What customers say</h3>
          <p>{data.summary.text}</p>
          <p className="muted small">Summarised by AI from {data.summary.count} written reviews. Read them below.</p>
        </div>
      )}
      {error && <p className="error">{error.message}</p>}
      {data &&
        (data.viewer ? (
          <MyReview key={data.viewer.review?.id ?? 'new'} slug={product.slug} viewer={data.viewer} onChange={changed} />
        ) : (
          <p className="muted">
            Bought this? <Link to={`/login?next=${encodeURIComponent(`/p/${product.slug}${hash}`)}`}>Log in</Link> to
            write a review.
          </p>
        ))}

      {written > 1 && (
        <ReviewFilters
          breakdown={data.breakdown}
          withPhotos={data.withPhotos}
          shown={data.total}
          view={view}
          onView={changeView}
        />
      )}
      {data && filtered && !data.items.length && (
        <p className="muted">
          No reviews like that yet.{' '}
          <button type="button" className="link" onClick={() => changeView({ ...view, stars: null, photos: false })}>
            Show all reviews
          </button>
        </p>
      )}
      {data?.items.length > 0 && (
        <ul className="review-list">
          {data.items.map((item) => {
            const r = { ...item, ...votes[item.id] };
            return (
              <li key={r.id} className="review">
                <ReviewText review={r} />
                <span className="muted small">
                  {r.author} · Verified buyer · {formatDate(r.createdAt)}
                </span>
                {r.id !== data.viewer?.review?.id && (
                  <HelpfulButton review={r} loggedIn={Boolean(data.viewer)} onVoted={onVoted} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </section>
  );
}
