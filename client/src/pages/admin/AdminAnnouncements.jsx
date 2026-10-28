import { useState } from 'react';
import { request } from '../../api.js';
import { formatDate, formatTime } from '../../format.js';
import { useFetch } from '../../useFetch.js';

const STATUS = { upcoming: 'Upcoming', showing: 'Showing', ended: 'Ended' };
const MAX_TEXT = 160; // as in server/src/announcements.js
const when = (iso) => `${formatDate(iso)}, ${formatTime(iso)}`;
// A datetime-local value (the admin's own time) from a Date.
const local = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

// New or `editing` (an announcement from the list). Uncontrolled: remounted with a key when that changes.
function AnnouncementForm({ editing, busy, onSave, onCancel }) {
  const now = new Date();
  function submit(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    onSave({
      text: f.text,
      link: f.link.trim(),
      startsAt: new Date(f.startsAt).toISOString(),
      endsAt: new Date(f.endsAt).toISOString(),
    });
  }
  return (
    <form className="sale-form" onSubmit={submit} aria-labelledby="announcement-form-heading">
      <h2 id="announcement-form-heading">{editing ? 'Edit announcement' : 'New announcement'}</h2>
      <label>
        Message
        <input
          name="text"
          required
          minLength={5}
          maxLength={MAX_TEXT}
          defaultValue={editing?.text}
          placeholder="Orders after 25 Oct ship after Diwali"
        />
      </label>
      <label>
        Link <span className="muted small">(optional: a page of the store, e.g. /help)</span>
        <input name="link" defaultValue={editing?.link ?? ''} placeholder="/search?q=diwali" />
      </label>
      <div className="address-grid">
        <label>
          Starts
          <input
            name="startsAt"
            type="datetime-local"
            required
            defaultValue={local(editing ? new Date(editing.startsAt) : now)}
          />
        </label>
        <label>
          Ends
          <input
            name="endsAt"
            type="datetime-local"
            required
            defaultValue={local(editing ? new Date(editing.endsAt) : new Date(now.getTime() + 7 * 86_400_000))}
          />
        </label>
      </div>
      <div className="admin-head-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {editing ? 'Save changes' : 'Schedule announcement'}
        </button>
        {editing && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

// Announcements (stage 71): a message across the top of the shop between two times.
export default function AdminAnnouncements() {
  const [version, setVersion] = useState(0);
  const { data, error } = useFetch('/admin/announcements', version);
  const [editing, setEditing] = useState(null);
  const [formKey, setFormKey] = useState(0);
  const [state, setState] = useState({ busy: false, error: null, done: null });

  async function run(action, done) {
    setState({ busy: true, error: null, done: null });
    try {
      await action();
      setState({ busy: false, error: null, done });
      setEditing(null);
      setFormKey((k) => k + 1);
      setVersion((v) => v + 1);
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
    }
  }

  const save = (body) =>
    editing
      ? run(() => request(`/admin/announcements/${editing.id}`, { method: 'PATCH', body }), 'Announcement saved.')
      : run(() => request('/admin/announcements', { method: 'POST', body }), 'Announcement scheduled.');
  const edit = (a) => {
    setEditing(a);
    setFormKey((k) => k + 1);
    setState({ busy: false, error: null, done: null });
  };

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Announcements</h1>
      </div>
      <p className="muted small">
        A short message across the top of every shop page between two times: delivery delays, holidays, a sale. Visitors
        can close it; a new one shows again. When two overlap, the one that started last shows.
      </p>

      {error && <p className="error">{error.message}</p>}
      {data?.items.length === 0 && <p className="muted">No announcements yet.</p>}
      {data?.items.length > 0 && (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Message</th>
                <th>When</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.text}
                    {a.link && <span className="muted small block">Links to {a.link}</span>}
                  </td>
                  <td className="small">
                    {when(a.startsAt)} to
                    <span className="block">{when(a.endsAt)}</span>
                  </td>
                  <td>
                    <span className={`status sale-${a.status === 'showing' ? 'running' : a.status}`}>
                      {a.status === 'showing' && !a.shown ? 'On, but hidden by a newer one' : STATUS[a.status]}
                    </span>
                  </td>
                  <td>
                    {a.status !== 'ended' && (
                      <div className="admin-head-actions">
                        <button type="button" className="link" disabled={state.busy} onClick={() => edit(a)}>
                          Edit<span className="sr-only"> “{a.text}”</span>
                        </button>
                        <button
                          type="button"
                          className="link danger"
                          disabled={state.busy}
                          onClick={() =>
                            run(
                              () => request(`/admin/announcements/${a.id}/end`, { method: 'POST' }),
                              a.status === 'showing' ? 'Announcement taken down.' : 'Announcement called off.',
                            )
                          }
                        >
                          {a.status === 'showing' ? 'End now' : 'Call off'}
                          <span className="sr-only"> “{a.text}”</span>
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && <p role="status">{state.done}</p>}
      <AnnouncementForm key={formKey} editing={editing} busy={state.busy} onSave={save} onCancel={() => edit(null)} />
    </section>
  );
}
