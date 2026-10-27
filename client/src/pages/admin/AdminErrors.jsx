import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { query, request } from '../../api.js';
import Pager from '../../components/Pager.jsx';
import { formatDate, formatTime } from '../../format.js';
import { useFetch } from '../../useFetch.js';

const FILTERS = [
  ['open', 'Open'],
  ['fixed', 'Fixed'],
];
const KINDS = { load: "Page didn't load", crash: 'Page crashed' };
const when = (iso) => `${formatDate(iso)}, ${formatTime(iso)}`;

// "Explain this error" (stage 57): Claude's plain-words reading of the report and where to look in the code, kept on
// the report. Shown only when the server has an API key (`ai.enabled`); asking again replaces it.
function Explanation({ report, ai, onChange }) {
  const [state, setState] = useState({ busy: false, error: null });
  const e = report.explanation;
  if (!ai?.enabled && !e) return null;

  async function explain() {
    setState({ busy: true, error: null });
    try {
      await request(`/admin/error-reports/${report.id}/explain`, { method: 'POST' });
      setState({ busy: false, error: null });
      onChange();
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <div className="error-explanation" aria-live="polite">
      {e && (
        <>
          <p>
            <strong>What it means</strong>
            {e.urgent && <span className="status urgent">Can stop people buying</span>}
          </p>
          <p>{e.explanation}</p>
          {e.whereToLook.length > 0 && (
            <>
              <p className="small">
                <strong>Where to look</strong>
              </p>
              <ul className="small">
                {e.whereToLook.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </>
          )}
          <p className="muted small">
            Explained by Claude on {when(e.at)}. A best guess from the report, which anyone could have sent: check it.
          </p>
        </>
      )}
      {ai?.enabled && (
        <button type="button" className="btn small" onClick={explain} disabled={state.busy}>
          {state.busy ? 'Explaining…' : e ? 'Explain again' : 'Explain this error'}
        </button>
      )}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
    </div>
  );
}

// One problem: what went wrong, how often and where, the details for whoever fixes it, and fixed/reopen.
function ReportCard({ report, ai, onChange }) {
  const [state, setState] = useState({ busy: false, error: null });
  const r = report;

  async function mark(fixed) {
    setState({ busy: true, error: null });
    try {
      await request(`/admin/error-reports/${r.id}/fixed`, { method: 'POST', body: { fixed } });
      setState({ busy: false, error: null });
      onChange();
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <li className="panel question-card error-report">
      <div className="muted small">
        {KINDS[r.kind]} · {r.count === 1 ? 'once' : `${r.count} times`} · last {when(r.lastAt)}
        {r.count > 1 && <> · first {when(r.firstAt)}</>}
      </div>
      <p className="error-message">{r.message}</p>
      <p className="small">
        On{' '}
        {r.paths.map((p, i) => (
          <span key={p}>
            {i > 0 && ', '}
            <code>{p}</code>
          </span>
        ))}
      </p>
      {(r.stack || r.componentStack || r.browser) && (
        <details>
          <summary>Details for fixing it</summary>
          {r.browser && <p className="muted small">Latest browser: {r.browser}</p>}
          {r.stack && (
            <pre className="error-stack" tabIndex={0}>
              {r.stack}
            </pre>
          )}
          {r.componentStack && (
            <>
              <p className="muted small">Inside these parts of the page:</p>
              <pre className="error-stack" tabIndex={0}>
                {r.componentStack.replace(/^\n+/, '').trimEnd()}
              </pre>
            </>
          )}
        </details>
      )}
      <Explanation report={r} ai={ai} onChange={onChange} />
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="btn small" disabled={state.busy} onClick={() => mark(!r.fixedAt)}>
          {r.fixedAt ? 'Reopen' : 'Mark fixed'}
        </button>
        {r.fixedAt && <span className="muted small">Marked fixed {when(r.fixedAt)}</span>}
      </div>
    </li>
  );
}

export default function AdminErrors() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'open';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [version, setVersion] = useState(0);
  // Whether the writing assistant is on (it needs an API key on the server).
  const { data: ai } = useFetch('/admin/ai');
  const { data, error, loading } = useFetch(
    `/admin/error-reports${query({ status, page: page > 1 ? page : '' })}`,
    version,
  );

  const update = (changes) => {
    const next = { status, ...changes };
    setParams(
      query({ status: next.status === 'open' ? '' : next.status, page: changes.page > 1 ? changes.page : '' }).slice(1),
    );
  };

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Errors</h1>
      </div>
      <p className="muted small">
        Pages that didn&apos;t load or crashed in visitors&apos; browsers, one entry per problem with how often it
        happened. Mark one fixed once a change for it is live; if it happens again it opens again. Entries go after 90
        days without a report.
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
        <p className="muted">
          {status === 'open' ? 'No errors reported. Everything has loaded for everyone.' : 'None here.'}
        </p>
      )}
      {data?.items.length > 0 && (
        <ul className={`question-list ${loading ? 'stale' : ''}`}>
          {data.items.map((r) => (
            <ReportCard key={r.id} report={r} ai={ai} onChange={() => setVersion((v) => v + 1)} />
          ))}
        </ul>
      )}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={(p) => update({ page: p })} />}
    </section>
  );
}
