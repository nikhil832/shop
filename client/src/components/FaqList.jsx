import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useFetch } from '../useFetch.js';

// Whether every typed word is in the question or its answer (ignoring case).
function matches(item, words) {
  const text = `${item.question} ${item.answer}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

// One question, opened by a click (a native disclosure), or already open when the page's address points at it.
function Entry({ item, open }) {
  return (
    <details id={`faq-${item.id}`} className="faq-entry" open={open || undefined}>
      <summary>{item.question}</summary>
      {item.answer.split(/\n\s*\n/).map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </details>
  );
}

// The store's FAQ (stage 130) with a search box. `compact` (the Help page) shows only the search, its results and a
// link to all of them, and nothing at all while the FAQ is empty.
export default function FaqList({ compact = false }) {
  const { data } = useFetch('/faq');
  const { hash } = useLocation();
  const [search, setSearch] = useState('');
  if (!data) return compact ? null : <p className="muted">Loading…</p>;
  if (!data.topics.length) return compact ? null : <p className="muted">No questions here yet.</p>;

  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const topics = data.topics
    .map((t) => ({ ...t, items: t.items.filter((i) => matches(i, words)) }))
    .filter((t) => t.items.length);
  const found = topics.reduce((n, t) => n + t.items.length, 0);

  return (
    <div className={`faq ${compact ? 'faq-compact' : ''}`}>
      <label className="faq-search">
        {compact ? 'Search our answers first' : 'Search the questions'}
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. refund" />
      </label>
      {/* Read out as the results change. */}
      <p className="muted small" aria-live="polite">
        {words.length > 0 && (found ? `${found} ${found === 1 ? 'answer' : 'answers'} found.` : 'Nothing found.')}
      </p>
      {(!compact || words.length > 0) &&
        topics.map((t) => (
          <section key={t.topic} className="faq-topic" aria-labelledby={`faq-topic-${t.topic}`}>
            <h2 id={`faq-topic-${t.topic}`}>{t.label}</h2>
            {t.items.map((item) => (
              <Entry key={item.id} item={item} open={words.length > 0 || hash === `#faq-${item.id}`} />
            ))}
          </section>
        ))}
      {compact && (
        <p className="small">
          <Link to="/faq">See all questions and answers</Link>
        </p>
      )}
    </div>
  );
}
