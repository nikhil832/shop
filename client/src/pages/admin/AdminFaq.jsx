import { useState } from 'react';
import { Link } from 'react-router';
import { request } from '../../api.js';
import { useFetch } from '../../useFetch.js';

// The question and answer fields, filled with `item` when editing. `topicNames` { key: label }.
function FaqFields({ item, topicNames }) {
  return (
    <>
      <label>
        Question
        <input name="question" required minLength={5} maxLength={150} defaultValue={item?.question} />
      </label>
      <label>
        Answer
        <textarea name="answer" required rows={5} maxLength={1500} defaultValue={item?.answer} />
        <span className="muted small">A blank line starts a new paragraph.</span>
      </label>
      <div className="form-row">
        <label>
          Topic
          <select name="topic" defaultValue={item?.topic ?? 'orders'}>
            {Object.entries(topicNames).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="check faq-shown">
          <input name="active" type="checkbox" defaultChecked={item?.active ?? true} />
          Shown in the shop
        </label>
      </div>
    </>
  );
}
const fieldsOf = (form) => {
  const f = new FormData(form);
  return {
    question: f.get('question'),
    answer: f.get('answer'),
    topic: f.get('topic'),
    active: f.get('active') === 'on',
  };
};

// /admin/faq (stage 130): the store's questions and answers, by topic, for /faq and the Help page. Admins and support.
export default function AdminFaq() {
  const [version, setVersion] = useState(0);
  const { data, error } = useFetch('/admin/faq', version);
  const [editing, setEditing] = useState(null);
  const [state, setState] = useState({ busy: false, error: null, done: null });

  async function run(change, done) {
    setState({ busy: true, error: null, done: null });
    try {
      await change();
      setState({ busy: false, error: null, done });
      setVersion((v) => v + 1);
      return true;
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
      return false;
    }
  }
  async function add(e) {
    e.preventDefault();
    const form = e.currentTarget;
    if (await run(() => request('/admin/faq', { method: 'POST', body: fieldsOf(form) }), 'Added.')) form.reset();
  }
  async function save(e, item) {
    e.preventDefault();
    const body = fieldsOf(e.currentTarget);
    if (await run(() => request(`/admin/faq/${item.id}`, { method: 'PUT', body }), 'Saved.')) setEditing(null);
  }
  const move = (item, direction) =>
    run(() => request(`/admin/faq/${item.id}/move`, { method: 'POST', body: { direction } }), null);
  const remove = (item) =>
    window.confirm(`Delete "${item.question}"?`) &&
    run(() => request(`/admin/faq/${item.id}`, { method: 'DELETE' }), 'Deleted.');

  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/admin/help">Help requests</Link>
        <span aria-hidden>›</span>
        <span>FAQ</span>
      </nav>
      <section className="panel">
        <div className="admin-head">
          <h1>Questions and answers</h1>
          <Link to="/faq">View in store ↗</Link>
        </div>
        <p className="muted small">
          Shown on the shop&apos;s Questions and answers page and searchable above the Help page&apos;s contact form.
          {` ${data.total} of ${data.max}.`}
        </p>
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        {state.done && <p role="status">{state.done}</p>}
        {data.topics.length === 0 && <p className="muted">No questions yet. Add the first one below.</p>}
        {data.topics.map((t) => (
          <section key={t.topic} className="faq-admin-topic" aria-labelledby={`admin-faq-${t.topic}`}>
            <h2 id={`admin-faq-${t.topic}`}>{t.label}</h2>
            <ol className="faq-admin-list">
              {t.items.map((item, i) => (
                <li key={item.id}>
                  {editing === item.id ? (
                    <form className="faq-form" onSubmit={(e) => save(e, item)} aria-label={`Edit "${item.question}"`}>
                      <FaqFields item={item} topicNames={data.topicNames} />
                      <div className="form-actions">
                        <button type="submit" className="btn primary" disabled={state.busy}>
                          Save
                        </button>
                        <button type="button" className="btn" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <p className="faq-admin-question">
                        {item.question}
                        {!item.active && <span className="muted small"> · hidden</span>}
                      </p>
                      <p className="muted small faq-admin-answer">{item.answer}</p>
                      <div className="faq-admin-actions">
                        <button type="button" className="link" onClick={() => setEditing(item.id)}>
                          Edit<span className="sr-only"> {item.question}</span>
                        </button>
                        <button
                          type="button"
                          className="link"
                          onClick={() => move(item, 'up')}
                          disabled={state.busy || i === 0}
                        >
                          Move up<span className="sr-only"> {item.question}</span>
                        </button>
                        <button
                          type="button"
                          className="link"
                          onClick={() => move(item, 'down')}
                          disabled={state.busy || i === t.items.length - 1}
                        >
                          Move down<span className="sr-only"> {item.question}</span>
                        </button>
                        <button type="button" className="link danger" onClick={() => remove(item)}>
                          Delete<span className="sr-only"> {item.question}</span>
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </section>
      <form className="panel faq-form" onSubmit={add} aria-labelledby="add-faq">
        <h2 id="add-faq">Add a question</h2>
        <FaqFields topicNames={data.topicNames} />
        <button type="submit" className="btn primary" disabled={state.busy || data.total >= data.max}>
          Add
        </button>
      </form>
    </>
  );
}
