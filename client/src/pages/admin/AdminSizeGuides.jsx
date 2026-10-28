import { useState } from 'react';
import { request } from '../../api.js';
import { useFetch } from '../../useFetch.js';

// The table as typed in the form: headings on the first line, a row per line, cells separated by commas.
const asText = (g) => [g.columns, ...g.rows].map((r) => r.join(', ')).join('\n');

// Adding a guide, or editing `guide`. Uncontrolled: remounted with a key when that changes.
function GuideForm({ guide, categories, busy, onSave, onCancel }) {
  return (
    <form
      className="sale-form"
      aria-labelledby="guide-form-heading"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        onSave({
          name: form.get('name'),
          table: form.get('table'),
          note: form.get('note'),
          categoryIds: form.getAll('categoryIds'),
        });
      }}
    >
      <h2 id="guide-form-heading">{guide ? `Edit “${guide.name}”` : 'New size guide'}</h2>
      <label>
        Name
        <input name="name" required minLength={2} maxLength={60} defaultValue={guide?.name} placeholder="Shoes" />
      </label>
      <label>
        Table
        <span className="muted small block">
          Headings on the first line, then a row per line; cells separated by commas (or paste from a spreadsheet).
        </span>
        <textarea
          name="table"
          rows={8}
          required
          defaultValue={guide ? asText(guide) : ''}
          placeholder={'UK, EU, Foot length (cm)\n7, 41, 25.4\n8, 42, 26.0'}
        />
      </label>
      <label>
        Note (optional)
        <input
          name="note"
          maxLength={300}
          defaultValue={guide?.note}
          placeholder="Measure your foot from heel to toe."
        />
      </label>
      <fieldset className="customer-tag-editor">
        <legend>For the products of</legend>
        {categories.map((c) => (
          <label key={c.id} className="check">
            <input type="checkbox" name="categoryIds" value={c.id} defaultChecked={guide?.categoryIds.includes(c.id)} />
            {c.name}
          </label>
        ))}
      </fieldset>
      <p className="muted small">A category has one guide. A product can use another, or none, from its own form.</p>
      <div className="admin-head-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {guide ? 'Save changes' : 'Add size guide'}
        </button>
        {guide && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

// Admin → Size guides (stage 88): size charts shown from the product page's "Size guide" link.
export default function AdminSizeGuides() {
  const [version, setVersion] = useState(0);
  const { data, error } = useFetch('/admin/size-guides', version);
  const { data: categories } = useFetch('/categories');
  const [editing, setEditing] = useState(null);
  const [formKey, setFormKey] = useState(0);
  const [state, setState] = useState({ busy: false, error: null, done: null });
  const names = new Map((categories ?? []).map((c) => [c.id, c.name]));

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
  const edit = (g) => {
    setEditing(g);
    setFormKey((k) => k + 1);
  };

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Size guides</h1>
      </div>
      <p className="muted small">
        Size charts for products with sizes. Product pages show &ldquo;Size guide&rdquo; beside the options when their
        category (or the product) has one.
      </p>
      {error && <p className="error">{error.message}</p>}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && <p role="status">{state.done}</p>}
      {data?.items.length === 0 && <p className="muted">No size guides yet.</p>}
      {data?.items.length > 0 && (
        <ul className="plain-list">
          {data.items.map((g) => (
            <li key={g.id}>
              <strong>{g.name}</strong> · {g.columns.join(' / ')} · {g.rows.length} rows
              <span className="muted small block">
                {g.categoryIds.length ? `For ${g.categoryIds.map((id) => names.get(id)).join(', ')}` : 'No category'}
              </span>
              <span className="admin-head-actions">
                <button type="button" className="link" onClick={() => edit(g)}>
                  Edit<span className="sr-only"> {g.name}</span>
                </button>
                <button
                  type="button"
                  className="link danger"
                  disabled={state.busy}
                  onClick={() =>
                    window.confirm(`Delete “${g.name}”?`) &&
                    run(() => request(`/admin/size-guides/${g.id}`, { method: 'DELETE' }), `“${g.name}” deleted.`)
                  }
                >
                  Delete<span className="sr-only"> {g.name}</span>
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {categories && (
        <GuideForm
          key={formKey}
          guide={editing}
          categories={categories}
          busy={state.busy}
          onCancel={() => edit(null)}
          onSave={(body) =>
            run(
              () =>
                editing
                  ? request(`/admin/size-guides/${editing.id}`, { method: 'PUT', body })
                  : request('/admin/size-guides', { method: 'POST', body }),
              editing ? 'Size guide saved.' : 'Size guide added.',
            )
          }
        />
      )}
    </section>
  );
}
