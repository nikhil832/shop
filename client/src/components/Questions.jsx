import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';
import { formatDate } from '../format.js';
import { useFetch } from '../useFetch.js';
import Pager from './Pager.jsx';

function AskForm({ slug, onAsked }) {
  const [state, setState] = useState({ busy: false, error: null });

  async function submit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    setState({ busy: true, error: null });
    try {
      await request(`/products/${slug}/questions`, { method: 'POST', body: { text: new FormData(form).get('text') } });
      form.reset();
      setState({ busy: false, error: null });
      onAsked();
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <form className="review-form" onSubmit={submit}>
      <label>
        Ask a question
        <textarea name="text" rows={2} maxLength={500} required placeholder="e.g. Is it machine washable?" />
      </label>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={state.busy}>
          Ask
        </button>
      </div>
    </form>
  );
}

// The visitor's own questions that nobody has answered yet: only they see them, and they can take them back.
function Waiting({ questions, onChange }) {
  const [error, setError] = useState(null);
  async function remove(q) {
    if (!window.confirm('Delete your question?')) return;
    try {
      await request(`/questions/${q.id}`, { method: 'DELETE' });
      onChange();
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <div className="panel my-review">
      <h3>Your {questions.length === 1 ? 'question' : 'questions'}, waiting for an answer</h3>
      <p className="muted small">
        Other customers see a question once the store has answered it. We&apos;ll email you.
      </p>
      <ul className="review-list">
        {questions.map((q) => (
          <li key={q.id} className="review">
            <p className="review-body">{q.text}</p>
            <div className="form-actions">
              <span className="muted small">Asked {formatDate(q.createdAt)}</span>
              <button type="button" className="link" onClick={() => remove(q)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

// Questions & answers under a product: the answered ones, and asking (logged in).
export default function Questions({ product }) {
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  // Waits for the login check, so a logged-in visitor's own questions come with the first load.
  const { data, error } = useFetch(
    user === undefined ? null : `/products/${product.slug}/questions?page=${page}`,
    `${version}:${user?.id ?? ''}`,
  );
  // Opened from the answer email (/p/…#questions): scroll here once the questions are in.
  const { hash } = useLocation();
  const loaded = Boolean(data);
  useEffect(() => {
    if (loaded && hash === '#questions') document.getElementById('questions')?.scrollIntoView();
  }, [loaded, hash]);
  const changed = () => {
    setPage(1);
    setVersion((v) => v + 1);
  };

  return (
    <section id="questions" className="reviews" aria-labelledby="questions-heading">
      <h2 id="questions-heading">Questions &amp; answers</h2>
      {user ? (
        <AskForm slug={product.slug} onAsked={changed} />
      ) : (
        user === null && (
          <p className="muted">
            <Link to={`/login?next=${encodeURIComponent(`/p/${product.slug}#questions`)}`}>Log in</Link> to ask a
            question about this product.
          </p>
        )
      )}
      {error && <p className="error">{error.message}</p>}
      {data?.waiting.length > 0 && <Waiting questions={data.waiting} onChange={changed} />}
      {data && data.total === 0 && <p className="muted">No answered questions yet.</p>}
      {data?.items.length > 0 && (
        <ul className="review-list">
          {data.items.map((q) => (
            <li key={q.id} className="review question">
              <p className="review-body">
                <strong>Q:</strong> {q.text}
              </p>
              <p className="review-body">
                <strong>A:</strong> {q.answer.text}
              </p>
              <span className="muted small">
                Asked by {q.author} · answered by Bazaar on {formatDate(q.answer.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </section>
  );
}
