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
        Other customers see a question once it has an answer, from us or from someone who bought it. We&apos;ll email
        you.
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

// One open question a buyer can answer (stage 133), with its own small form.
function AnswerForm({ question, onAnswered }) {
  const [state, setState] = useState({ busy: false, error: null });
  async function submit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    setState({ busy: true, error: null });
    try {
      await request(`/questions/${question.id}/answers`, {
        method: 'POST',
        body: { text: new FormData(form).get('text') },
      });
      setState({ busy: false, error: null });
      onAnswered();
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }
  return (
    <li className="review question">
      <p className="review-body">
        <strong>Q:</strong> {question.text}
      </p>
      <form className="review-form answer-form" onSubmit={submit} aria-label={`Answer: ${question.text}`}>
        <label>
          Your answer
          <textarea name="text" rows={2} minLength={2} maxLength={500} required />
        </label>
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        <div className="form-actions">
          <span className="muted small">Asked by {question.author}</span>
          <button type="submit" className="btn" disabled={state.busy}>
            Post answer
          </button>
        </div>
      </form>
    </li>
  );
}

// Questions & answers under a product: the answered ones, and asking (logged in).
// `canScroll`: the page's rows above have loaded, so a #questions link can scroll here.
export default function Questions({ product, canScroll }) {
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
  const loaded = Boolean(data) && canScroll;
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
              {!q.answer && <span className="muted small block">Asked by {q.author}</span>}
              {/* The store's answer first, then customers' (stage 133). */}
              {q.answer && (
                <>
                  <p className="review-body">
                    <strong>A:</strong> {q.answer.text}
                  </p>
                  <span className="muted small">
                    Asked by {q.author} · answered by Bazaar on {formatDate(q.answer.at)}
                  </span>
                </>
              )}
              {q.customerAnswers.length > 0 && (
                <ul className="customer-answers">
                  {q.customerAnswers.map((a) => (
                    <li key={a.id}>
                      <p className="review-body">
                        <strong>A:</strong> {a.text}
                      </p>
                      <span className="muted small">
                        {a.author} <span className="bought-badge">Bought this</span> · {formatDate(a.at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {/* Buyers can answer what others asked (stage 133). */}
      {data?.canAnswer && data.open.length > 0 && (
        <section className="panel can-help" aria-labelledby="can-help-heading">
          <h3 id="can-help-heading">Can you help?</h3>
          <p className="muted small">You bought this, so you can answer other customers&apos; questions about it.</p>
          <ul className="review-list">
            {data.open.map((q) => (
              <AnswerForm key={q.id} question={q} onAnswered={changed} />
            ))}
          </ul>
        </section>
      )}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={setPage} />}
    </section>
  );
}
