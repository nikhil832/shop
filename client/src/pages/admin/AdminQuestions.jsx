import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { query, request } from '../../api.js';
import Pager from '../../components/Pager.jsx';
import { formatDate } from '../../format.js';
import { useFetch } from '../../useFetch.js';

const FILTERS = [
  ['unanswered', 'Waiting for an answer'],
  ['answered', 'Answered'],
  ['hidden', 'Hidden'],
];

// One question: who asked what about which product, the answer box, and hide/show.
function QuestionCard({ question, onChange }) {
  const [state, setState] = useState({ busy: false, error: null, saved: false });
  const q = question;

  async function send(path, body) {
    setState({ busy: true, error: null, saved: false });
    try {
      await request(path, { method: path.endsWith('answer') ? 'PUT' : 'POST', body });
      setState({ busy: false, error: null, saved: true });
      onChange();
    } catch (err) {
      setState({ busy: false, error: err.message, saved: false });
    }
  }

  function answer(e) {
    e.preventDefault();
    send(`/admin/questions/${q.id}/answer`, { text: new FormData(e.currentTarget).get('text') });
  }

  return (
    <li className="panel question-card">
      <div className="muted small">
        {q.product ? <Link to={`/p/${q.product.slug}#questions`}>{q.product.title}</Link> : 'A deleted product'} ·{' '}
        {q.customer ? `${q.customer.name} (${q.customer.email})` : q.author} · {formatDate(q.createdAt)}
      </div>
      <p className="review-body">
        <strong>Q:</strong> {q.text}
      </p>
      <form className="review-form" onSubmit={answer}>
        <label>
          {q.answer ? 'Answer' : 'Your answer'}
          <textarea name="text" rows={3} maxLength={2000} required defaultValue={q.answer?.text ?? ''} />
        </label>
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="btn primary small" disabled={state.busy}>
            {q.answer ? 'Save answer' : 'Answer'}
          </button>
          <button
            type="button"
            className="btn small"
            disabled={state.busy}
            onClick={() => send(`/admin/questions/${q.id}/visibility`, { hidden: !q.hidden })}
          >
            {q.hidden ? 'Show' : 'Hide'}
          </button>
          {q.answer && <span className="muted small">Answered {formatDate(q.answer.at)}</span>}
        </div>
      </form>
    </li>
  );
}

export default function AdminQuestions() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'unanswered';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [version, setVersion] = useState(0);
  const { data, error, loading } = useFetch(
    `/admin/questions${query({ status, page: page > 1 ? page : '' })}`,
    version,
  );

  const update = (changes) => {
    const next = { status, ...changes };
    setParams(
      query({
        status: next.status === 'unanswered' ? '' : next.status,
        page: changes.page > 1 ? changes.page : '',
      }).slice(1),
    );
  };

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Questions</h1>
      </div>
      <p className="muted small">
        Customers&apos; questions about products. Answered ones appear on the product page, and the customer is emailed
        the first answer. Hiding a question takes it off the page; nothing is deleted.
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
        <p className="muted">{status === 'unanswered' ? 'No questions are waiting for an answer.' : 'None here.'}</p>
      )}
      {data?.items.length > 0 && (
        <ul className={`question-list ${loading ? 'stale' : ''}`}>
          {data.items.map((q) => (
            // Remounted when the answer or visibility changes, so the answer box shows what was saved.
            <QuestionCard
              key={`${q.id}:${q.answer?.text ?? ''}:${q.hidden}`}
              question={q}
              onChange={() => setVersion((v) => v + 1)}
            />
          ))}
        </ul>
      )}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={(p) => update({ page: p })} />}
    </section>
  );
}
