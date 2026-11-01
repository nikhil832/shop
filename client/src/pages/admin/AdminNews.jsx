import { useState } from 'react';
import { request } from '../../api.js';
import { formatDate, formatTime } from '../../format.js';
import { useFetch } from '../../useFetch.js';

// Store news (stage 140): write an email, send yourself a test, then send it to the customers who asked for store news.
// The server sends a batch every minute, at most `dailyLimit` a day, so a long list takes a few days.
const when = (iso) => `${formatDate(iso)}, ${formatTime(iso)}`;
const STATUS = { draft: 'Draft', sending: 'Sending', sent: 'Sent' };

// Who gets it (stage 143): everyone subscribed, a loyalty level (while levels are on), a customer tag, or buyers from
// a category; the subscribers in it are counted as it's chosen.
const TAG_GROUPS = { vip: 'VIP', wholesale: 'Wholesale', watch: 'Watch' };
function GroupPicker({ group, onChange }) {
  const { data: categories } = useFetch('/categories');
  const { data: loyalty } = useFetch('/admin/loyalty');
  const { data: count, error } = useFetch(`/admin/newsletters/group?group=${encodeURIComponent(group)}`);
  return (
    <label>
      Who gets it
      <select name="group" value={group} onChange={(e) => onChange(e.target.value)} aria-describedby="group-count">
        <option value="all">Everyone who asked for store news</option>
        {loyalty?.enabled && (
          <optgroup label="Loyalty level">
            <option value="loyalty:silver">Silver and Gold members</option>
            <option value="loyalty:gold">Gold members</option>
          </optgroup>
        )}
        <optgroup label="Customer tag">
          {Object.entries(TAG_GROUPS).map(([tag, label]) => (
            <option key={tag} value={`tag:${tag}`}>
              Customers tagged {label}
            </option>
          ))}
        </optgroup>
        {categories?.length > 0 && (
          <optgroup label="Bought from">
            {categories.map((c) => (
              <option key={c.id} value={`category:${c.id}`}>
                Customers who bought from {c.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <span id="group-count" className="muted small" aria-live="polite">
        {error
          ? error.message
          : count && `${count.count} ${count.count === 1 ? 'subscriber' : 'subscribers'} in this group now`}
      </span>
    </label>
  );
}

function LetterForm({ letter, onSaved, onCancel }) {
  const [state, setState] = useState({ busy: false, error: null });
  const [group, setGroup] = useState(letter?.group ?? 'all');
  async function submit(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null });
    try {
      await request(letter ? `/admin/newsletters/${letter.id}` : '/admin/newsletters', {
        method: letter ? 'PUT' : 'POST',
        body: { subject: f.subject, body: f.body, link: f.link.trim(), linkText: f.linkText, group },
      });
      onSaved(letter ? 'Saved.' : 'Draft saved. Send yourself a test before sending it out.');
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }
  return (
    <form className="sale-form" onSubmit={submit} aria-labelledby="news-form-heading">
      <h2 id="news-form-heading">{letter ? 'Edit the email' : 'New email'}</h2>
      <label>
        Subject
        <input name="subject" required minLength={3} maxLength={120} defaultValue={letter?.subject} />
      </label>
      <label>
        Text <span className="muted small">(a blank line starts a new paragraph; &ldquo;Hi Name,&rdquo; is added)</span>
        <textarea name="body" required minLength={10} maxLength={5000} rows={8} defaultValue={letter?.body} />
      </label>
      <GroupPicker group={group} onChange={setGroup} />
      <div className="address-grid">
        <label>
          Button link <span className="muted small">(optional: a page of the store, e.g. /search?deals=1)</span>
          <input name="link" maxLength={200} defaultValue={letter?.link} />
        </label>
        <label>
          Button text <span className="muted small">(optional)</span>
          <input name="linkText" maxLength={30} defaultValue={letter?.linkText} placeholder="Shop now" />
        </label>
      </div>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <div className="admin-head-actions">
        <button type="submit" className="btn primary" disabled={state.busy}>
          {letter ? 'Save' : 'Save draft'}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export default function AdminNews() {
  const [version, setVersion] = useState(0);
  const { data, error } = useFetch('/admin/newsletters', version);
  const [editing, setEditing] = useState(null); // a letter, 'new' or null
  const [state, setState] = useState({ busy: false, error: null, done: null });

  async function run(change, done) {
    setState({ busy: true, error: null, done: null });
    try {
      const result = await change();
      setState({ busy: false, error: null, done: typeof done === 'function' ? done(result) : done });
      setVersion((v) => v + 1);
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
    }
  }
  const saved = (message) => {
    setEditing(null);
    setState({ busy: false, error: null, done: message });
    setVersion((v) => v + 1);
  };
  const test = (l) =>
    run(
      () => request(`/admin/newsletters/${l.id}/test`, { method: 'POST' }),
      (r) => `A test went to ${r.sentTo}.`,
    );
  // The group's subscribers are counted first, so the question names the real number.
  async function send(l) {
    let count;
    try {
      ({ count } = await request(`/admin/newsletters/group?group=${encodeURIComponent(l.group)}`));
    } catch (err) {
      return setState({ busy: false, error: err.message, done: null });
    }
    if (!count) return setState({ busy: false, error: 'Nobody in this group has asked for store news', done: null });
    const who = `${count} ${count === 1 ? 'customer' : 'customers'} (${l.groupLabel})`;
    if (!window.confirm(`Send “${l.subject}” to ${who}? It can't be changed afterwards.`)) return;
    run(
      () => request(`/admin/newsletters/${l.id}/send`, { method: 'POST' }),
      'Sending. It goes out over the next minutes.',
    );
  }
  const remove = (l) =>
    window.confirm(`Delete the draft “${l.subject}”?`) &&
    run(() => request(`/admin/newsletters/${l.id}`, { method: 'DELETE' }), 'Draft deleted.');

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Store news</h1>
        {!editing && (
          <button type="button" className="btn primary" onClick={() => setEditing('new')}>
            Write an email
          </button>
        )}
      </div>
      {data && (
        <p className="muted small">
          {data.subscribers === 1 ? '1 customer has' : `${data.subscribers} customers have`} asked for store news on
          their account page. Every email has an unsubscribe link.{' '}
          {`At most ${data.dailyLimit} go out a day (${data.sentToday} so far today), leaving room for order emails, so a long list takes a few days.`}
        </p>
      )}
      {editing && (
        <LetterForm
          key={editing === 'new' ? 'new' : editing.id}
          letter={editing === 'new' ? null : editing}
          onSaved={saved}
          onCancel={() => setEditing(null)}
        />
      )}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && <p role="status">{state.done}</p>}
      {error && <p className="error">{error.message}</p>}
      {data?.items.length === 0 && <p className="muted">No emails yet.</p>}
      {data?.items.length > 0 && (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((l) => (
                <tr key={l.id}>
                  <td>
                    <strong>{l.subject}</strong>
                    <span className="muted small block">
                      To: {l.groupLabel}.{' '}
                      {l.status === 'draft' ? `Written ${when(l.updatedAt)}` : `Sent from ${when(l.queuedAt)}`}
                      {l.by && ` by ${l.by}`}
                    </span>
                  </td>
                  <td className="small">
                    <span className="block">{STATUS[l.status]}</span>
                    {l.status !== 'draft' && (
                      <span className="muted block">
                        {l.sent} of {l.recipients} sent{l.failed > 0 && `, ${l.failed} failed`}
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="admin-head-actions">
                      <button type="button" className="link" disabled={state.busy} onClick={() => test(l)}>
                        Send me a test<span className="sr-only"> of “{l.subject}”</span>
                      </button>
                      {l.status === 'draft' && (
                        <>
                          <button type="button" className="link" disabled={state.busy} onClick={() => setEditing(l)}>
                            Edit<span className="sr-only"> “{l.subject}”</span>
                          </button>
                          <button
                            type="button"
                            className="link"
                            disabled={state.busy || !data.subscribers}
                            onClick={() => send(l)}
                          >
                            Send to subscribers<span className="sr-only"> “{l.subject}”</span>
                          </button>
                          <button type="button" className="link danger" disabled={state.busy} onClick={() => remove(l)}>
                            Delete<span className="sr-only"> “{l.subject}”</span>
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
