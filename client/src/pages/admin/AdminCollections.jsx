import { useState } from 'react';
import { Link } from 'react-router';
import { query, request } from '../../api.js';
import { formatDate, formatPrice, formatTime } from '../../format.js';
import { useFetch } from '../../useFetch.js';

const MAX_PRODUCTS = 48; // as server/src/collections.js
const STATUS = { live: 'Live', upcoming: 'Starts later', ended: 'Ended', off: 'Off' };
// A Date as the value of a datetime-local input (the browser's time), or ''.
const local = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const when = (iso) => `${formatDate(iso)}, ${formatTime(iso)}`;

// Finds products to add, and lists the chosen ones in their order (moved up or down, or removed).
function Picker({ chosen, onChange }) {
  const [q, setQ] = useState('');
  const { data } = useFetch(q.trim().length >= 2 ? `/admin/products${query({ q: q.trim() })}` : null);
  const move = (i, by) => {
    const next = [...chosen];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onChange(next);
  };
  return (
    <div className="sale-picker">
      <label>
        Find products
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a title or brand" />
      </label>
      {data?.items.length > 0 && (
        <ul className="sale-results">
          {data.items.slice(0, 8).map((p) => (
            <li key={p.id}>
              <span>
                {p.title} <span className="muted small">{formatPrice(p.price)}</span>
              </span>
              <button
                type="button"
                className="link"
                disabled={chosen.length >= MAX_PRODUCTS || chosen.some((c) => c.id === p.id)}
                onClick={() => {
                  onChange([...chosen, p]);
                  setQ('');
                }}
              >
                Add<span className="sr-only"> {p.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {chosen.length > 0 && (
        <ol className="sale-chosen collection-chosen" aria-label="Products in the collection">
          {chosen.map((c, i) => (
            <li key={c.id}>
              {c.title}
              {c.shown === false && <span className="muted small"> (hidden)</span>}{' '}
              <span className="admin-head-actions">
                <button type="button" className="link" disabled={i === 0} onClick={() => move(i, -1)}>
                  Up<span className="sr-only"> {c.title}</span>
                </button>
                <button type="button" className="link" disabled={i === chosen.length - 1} onClick={() => move(i, 1)}>
                  Down<span className="sr-only"> {c.title}</span>
                </button>
                <button
                  type="button"
                  className="link danger"
                  onClick={() => onChange(chosen.filter((x) => x.id !== c.id))}
                >
                  Remove<span className="sr-only"> {c.title}</span>
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// The new or edited collection. `editing` is an admin row, or null for a new one.
function CollectionForm({ editing, busy, onSave, onCancel }) {
  const [chosen, setChosen] = useState(editing?.products ?? []);
  function submit(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const date = (name) => (f.get(name) ? new Date(f.get(name)).toISOString() : null);
    onSave({
      name: f.get('name'),
      description: f.get('description'),
      productIds: chosen.map((p) => p.id),
      startsAt: date('startsAt'),
      endsAt: date('endsAt'),
      onHome: f.get('onHome') === 'on',
      active: f.get('active') === 'on',
    });
  }
  const title = editing ? `Edit ${editing.name}` : 'New collection';
  return (
    <form className="sale-form" onSubmit={submit} aria-labelledby="collection-form-heading">
      <h2 id="collection-form-heading">{title}</h2>
      <label>
        Name
        <input
          name="name"
          required
          minLength={2}
          maxLength={60}
          defaultValue={editing?.name}
          placeholder="Diwali gifts"
        />
      </label>
      <label>
        Description (optional)
        <textarea name="description" rows="2" maxLength={300} defaultValue={editing?.description} />
      </label>
      <Picker chosen={chosen} onChange={setChosen} />
      <div className="address-grid">
        <label>
          Starts (optional)
          <input name="startsAt" type="datetime-local" defaultValue={local(editing?.startsAt)} />
        </label>
        <label>
          Ends (optional)
          <input name="endsAt" type="datetime-local" defaultValue={local(editing?.endsAt)} />
        </label>
      </div>
      <label className="check">
        <input name="onHome" type="checkbox" defaultChecked={editing?.onHome ?? true} /> Show it on the home page
      </label>
      <label className="check">
        <input name="active" type="checkbox" defaultChecked={editing?.active ?? true} /> Shown (untick to switch it off)
      </label>
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy || chosen.length === 0}>
          {editing ? 'Save collection' : 'Add collection'}
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

// Admin → Collections (stage 91): hand-picked product lists with their own page (/c/…), live between optional dates;
// up to three live ones marked for it are rows on the home page, in this list's order.
export default function AdminCollections() {
  const [version, setVersion] = useState(0);
  const { data, error } = useFetch('/admin/collections', version);
  // The collection being edited, or null; `formKey` starts a fresh form.
  const [editing, setEditing] = useState(null);
  const [formKey, setFormKey] = useState(0);
  const [state, setState] = useState({ busy: false, error: null, done: null });

  async function run(action, done) {
    setState({ busy: true, error: null, done: null });
    try {
      await action();
      setState({ busy: false, error: null, done });
      setVersion((v) => v + 1);
      return true;
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
      return false;
    }
  }
  async function save(body) {
    const ok = await run(
      () =>
        editing
          ? request(`/admin/collections/${editing.id}`, { method: 'PUT', body })
          : request('/admin/collections', { method: 'POST', body }),
      editing ? `“${body.name}” saved.` : `“${body.name}” added.`,
    );
    if (ok) {
      setEditing(null);
      setFormKey((k) => k + 1);
    }
  }
  const remove = (c) =>
    window.confirm(`Delete “${c.name}”? Its page stops working; the products stay.`) &&
    run(() => request(`/admin/collections/${c.id}`, { method: 'DELETE' }), `“${c.name}” deleted.`);
  const move = (c, direction) =>
    run(() => request(`/admin/collections/${c.id}/move`, { method: 'POST', body: { direction } }), null);

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Collections</h1>
      </div>
      <p className="muted small">
        Hand-picked products with a page and link of their own, for promotions and posts. Up to three live ones marked
        for the home page show there as rows, in this order. Hidden products are left out of the page.
      </p>
      {error && <p className="error">{error.message}</p>}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && <p role="status">{state.done}</p>}
      {data?.items.length === 0 && <p className="muted">No collections yet.</p>}
      {data?.items.length > 0 && (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Collection</th>
                <th>When</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((c, i) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/c/${c.slug}`}>{c.name}</Link>
                    <span className="muted small block">
                      {c.products.length} {c.products.length === 1 ? 'product' : 'products'}
                      {c.products.some((p) => !p.shown) && ` (${c.products.filter((p) => !p.shown).length} hidden)`}
                      {c.onHome && ' · on the home page'}
                    </span>
                  </td>
                  <td className="small">
                    {c.startsAt || c.endsAt ? (
                      <>
                        {c.startsAt ? when(c.startsAt) : 'Now'} to {c.endsAt ? when(c.endsAt) : 'no end'}
                      </>
                    ) : (
                      'Always'
                    )}
                  </td>
                  <td>{STATUS[c.status]}</td>
                  <td>
                    <div className="admin-head-actions">
                      <button
                        type="button"
                        className="link"
                        disabled={state.busy || i === 0}
                        onClick={() => move(c, 'up')}
                      >
                        Up<span className="sr-only"> {c.name}</span>
                      </button>
                      <button
                        type="button"
                        className="link"
                        disabled={state.busy || i === data.items.length - 1}
                        onClick={() => move(c, 'down')}
                      >
                        Down<span className="sr-only"> {c.name}</span>
                      </button>
                      <button
                        type="button"
                        className="link"
                        onClick={() => {
                          setEditing(c);
                          setFormKey((k) => k + 1);
                        }}
                      >
                        Edit<span className="sr-only"> {c.name}</span>
                      </button>
                      <button type="button" className="link danger" disabled={state.busy} onClick={() => remove(c)}>
                        Delete<span className="sr-only"> {c.name}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CollectionForm
        key={formKey}
        editing={editing}
        busy={state.busy}
        onSave={save}
        onCancel={() => {
          setEditing(null);
          setFormKey((k) => k + 1);
        }}
      />
    </section>
  );
}
