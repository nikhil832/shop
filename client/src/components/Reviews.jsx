import { useState } from 'react';
import { Link } from 'react-router';
import { request } from '../api.js';
import { formatDate } from '../format.js';
import { useFetch } from '../useFetch.js';
import Pager from './Pager.jsx';
import Rating from './Rating.jsx';
import Stars from './Stars.jsx';

function ReviewForm({ slug, review, onSaved, onCancel }) {
  const [stars, setStars] = useState(review?.rating ?? 0);
  const [state, setState] = useState({ busy: false, error: null });

  async function submit(e) {
    e.preventDefault();
    if (!stars) return setState({ busy: false, error: 'Choose 1 to 5 stars' });
    const form = new FormData(e.currentTarget);
    setState({ busy: true, error: null });
    try {
      await request(`/products/${slug}/review`, {
        method: 'PUT',
        body: { rating: stars, title: form.get('title'), body: form.get('body') },
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

function ReviewText({ review }) {
  return (
    <>
      <div className="review-head">
        <Stars rating={review.rating} />
        {review.title && <strong>{review.title}</strong>}
      </div>
      {review.body && <p className="review-body">{review.body}</p>}
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

// Ratings & reviews under a product. `onChange` tells the page to reload the product, whose rating just changed.
export default function Reviews({ product, onChange }) {
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const { data, error } = useFetch(`/products/${product.slug}/reviews?page=${page}`, version);

  const changed = () => {
    setPage(1);
    setVersion((v) => v + 1);
    onChange();
  };

  return (
    <section className="reviews" aria-labelledby="reviews-heading">
      <h2 id="reviews-heading">Ratings &amp; reviews</h2>
      <div className="reviews-summary">
        {product.rating.count ? (
          <>
            <Rating rating={product.rating} count={false} />
            <span className="muted">
              {product.rating.count.toLocaleString('en-IN')} {product.rating.count === 1 ? 'rating' : 'ratings'}
              {data && ` · ${data.total} written ${data.total === 1 ? 'review' : 'reviews'}`}
            </span>
          </>
        ) : (
          <span className="muted">No ratings yet.</span>
        )}
      </div>

      {error && <p className="error">{error.message}</p>}
      {data &&
        (data.viewer ? (
          <MyReview key={data.viewer.review?.id ?? 'new'} slug={product.slug} viewer={data.viewer} onChange={changed} />
        ) : (
          <p className="muted">
            Bought this? <Link to={`/login?next=${encodeURIComponent(`/p/${product.slug}`)}`}>Log in</Link> to write a
            review.
          </p>
        ))}

      {data?.items.length > 0 && (
        <ul className="review-list">
          {data.items.map((r) => (
            <li key={r.id} className="review">
              <ReviewText review={r} />
              <span className="muted small">
                {r.author} · Verified buyer · {formatDate(r.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </section>
  );
}
