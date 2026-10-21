import { useState } from 'react';
import { request } from '../../api.js';
import { useFetch } from '../../useFetch.js';

export default function AdminCategories() {
  const [version, setVersion] = useState(0);
  const { data: categories, error } = useFetch('/admin/categories', version);
  const [state, setState] = useState({ busy: false, error: null });

  // Runs a change, then reloads the list; errors show above the table.
  async function run(change) {
    setState({ busy: true, error: null });
    try {
      await change();
      setState({ busy: false, error: null });
      setVersion((v) => v + 1);
      return true;
    } catch (err) {
      setState({ busy: false, error: err.message });
      return false;
    }
  }

  const fields = (form) => {
    const body = Object.fromEntries(new FormData(form));
    if (!body.icon?.trim()) delete body.icon;
    return body;
  };

  async function add(e) {
    e.preventDefault();
    const form = e.currentTarget;
    if (await run(() => request('/admin/categories', { method: 'POST', body: fields(form) }))) form.reset();
  }

  const rename = (category) => (e) => {
    e.preventDefault();
    run(() => request(`/admin/categories/${category.id}`, { method: 'PATCH', body: fields(e.currentTarget) }));
  };

  const move = (i, by) => {
    const ids = categories.map((c) => c.id);
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    run(() => request('/admin/categories/order', { method: 'PUT', body: { ids } }));
  };

  const remove = (category) => {
    if (!window.confirm(`Delete the category “${category.name}”?`)) return;
    run(() => request(`/admin/categories/${category.id}`, { method: 'DELETE' }));
  };

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Categories</h1>
      </div>
      <p className="muted small">
        Shown in this order on the home page. A category's link (its slug) stays the same when it is renamed. Only empty
        categories can be deleted.
      </p>
      {(state.error || error) && (
        <p className="error" role="alert">
          {state.error ?? error.message}
        </p>
      )}

      <ul className="category-list">
        {categories?.map((c, i) => (
          // Keyed by name and icon so the inputs show saved values after a change.
          <li key={`${c.id}:${c.name}:${c.icon}`}>
            <form className="category-row" onSubmit={rename(c)}>
              <input
                name="icon"
                defaultValue={c.icon}
                aria-label={`Icon of ${c.name}`}
                className="icon-input"
                maxLength={8}
              />
              <input name="name" defaultValue={c.name} aria-label={`Name of ${c.name}`} required maxLength={40} />
              <button type="submit" className="btn small" disabled={state.busy}>
                Save
              </button>
              <span className="muted small count-cell">
                {c.productCount} {c.productCount === 1 ? 'product' : 'products'} · /{c.slug}
              </span>
              <span className="row-actions">
                <button
                  type="button"
                  className="btn small"
                  disabled={state.busy || i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`Move ${c.name} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn small"
                  disabled={state.busy || i === categories.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`Move ${c.name} down`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn small"
                  disabled={state.busy || c.productCount > 0}
                  title={c.productCount > 0 ? 'Move or hide its products first' : undefined}
                  onClick={() => remove(c)}
                  aria-label={`Delete ${c.name}`}
                >
                  Delete
                </button>
              </span>
            </form>
          </li>
        ))}
      </ul>

      <form className="category-row add" onSubmit={add}>
        <input name="icon" placeholder="🛍️" aria-label="New category icon" className="icon-input" maxLength={8} />
        <input name="name" placeholder="New category name" aria-label="New category name" required maxLength={40} />
        <button type="submit" className="btn primary small" disabled={state.busy}>
          Add category
        </button>
      </form>
    </section>
  );
}
