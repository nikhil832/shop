import { useRef, useState } from 'react';
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

// "Draft an answer" (stage 56): Claude drafts a reply from the product's details and earlier answers into the answer
// box, for the admin to check and edit before answering. Shown only when the server has an API key (`ai.enabled`).
function DraftAnswer({ question, textRef }) {
  const [state, setState] = useState({ busy: false, error: null, draft: null });

  async function draft() {
    if (textRef.current.value.trim() && !window.confirm('Replace what you wrote with a draft?')) return;
    setState({ busy: true, error: null, draft: null });
    try {
      const res = await request('/admin/ai/answer-draft', { method: 'POST', body: { questionId: question.id } });
      textRef.current.value = res.answer;
      textRef.current.focus();
      setState({ busy: false, error: null, draft: res });
    } catch (err) {
      setState({ busy: false, error: err.message, draft: null });
    }
  }

  return (
    <>
      <button type="button" className="btn small" onClick={draft} disabled={state.busy}>
        {state.busy ? 'Drafting…' : 'Draft an answer'}
      </button>
      <p className={`small ${state.draft && !state.draft.fromDetails ? 'warning-text' : 'muted'}`} aria-live="polite">
        {state.draft &&
          (state.draft.fromDetails
            ? 'Draft written from the product’s details. Check it before answering: it can get things wrong.'
            : 'The product’s details don’t settle this: check the facts and finish the answer yourself.')}
      </p>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
    </>
  );
}

// One question: who asked what about which product, the answer box, and hide/show.
function QuestionCard({ question, onChange, ai }) {
  const [state, setState] = useState({ busy: false, error: null, saved: false });
  const textRef = useRef(null);
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
          <textarea ref={textRef} name="text" rows={3} maxLength={2000} required defaultValue={q.answer?.text ?? ''} />
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
        {ai?.enabled && <DraftAnswer question={q} textRef={textRef} />}
      </form>
    </li>
  );
}

export default function AdminQuestions() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'unanswered';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [version, setVersion] = useState(0);
  // Whether the writing assistant is on (it needs an API key on the server).
  const { data: ai } = useFetch('/admin/ai');
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
              ai={ai}
              onChange={() => setVersion((v) => v + 1)}
            />
          ))}
        </ul>
      )}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={(p) => update({ page: p })} />}
    </section>
  );
}
