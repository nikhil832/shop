import { useState } from 'react';
import { query, request } from '../../api.js';
import { formatPrice, toPaise } from '../../format.js';
import { useFetch } from '../../useFetch.js';

// Picks 2–3 products without sizes or colours for a new bundle; `chosen` are admin product rows.
function Picker({ chosen, onChange }) {
  const [q, setQ] = useState('');
  const { data } = useFetch(q.trim().length >= 2 ? `/admin/products${query({ q: q.trim() })}` : null);
  const simple = data?.items.filter((p) => !p.variants.length) ?? [];
  return (
    <div className="sale-picker">
      <label>
        Find products
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a title or brand" />
      </label>
      {simple.length > 0 && (
        <ul className="sale-results">
          {simple.slice(0, 8).map((p) => (
            <li key={p.id}>
              <span>
                {p.title} <span className="muted small">{formatPrice(p.price)}</span>
              </span>
              <button
                type="button"
                className="link"
                disabled={chosen.length >= 3 || chosen.some((c) => c.id === p.id)}
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
        <ul className="sale-chosen" aria-label="Products in the bundle">
          {chosen.map((c) => (
            <li key={c.id}>
              {c.title} <span className="muted small">{formatPrice(c.price)}</span>{' '}
              <button
                type="button"
                className="link danger"
                onClick={() => onChange(chosen.filter((x) => x.id !== c.id))}
              >
                Remove<span className="sr-only"> {c.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Admin → Bundles (stage 83): 2–3 products sold together at a bundle price. The cart takes the saving off whenever it
// holds a full set; a bundle that no longer saves anything (a sale lowered the prices) isn't applied or shown.
export default function AdminBundles() {
  const [version, setVersion] = useState(0);
  const { data, error } = useFetch('/admin/bundles', version);
  const [chosen, setChosen] = useState([]);
  const [formKey, setFormKey] = useState(0);
  const [state, setState] = useState({ busy: false, error: null, done: null });
  const regular = chosen.reduce((s, p) => s + p.price, 0);

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

  async function create(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    const ok = await run(
      () =>
        request('/admin/bundles', {
          method: 'POST',
          body: { name: f.name, productIds: chosen.map((p) => p.id), price: toPaise(f.price) },
        }),
      `“${f.name}” added.`,
    );
    if (ok) {
      setChosen([]);
      setFormKey((k) => k + 1);
    }
  }

  const changePrice = (b) => {
    const value = window.prompt(`New bundle price for “${b.name}” (₹), below ${formatPrice(b.regular)}:`);
    if (value)
      run(
        () => request(`/admin/bundles/${b.id}`, { method: 'PATCH', body: { price: toPaise(value) } }),
        'Price saved.',
      );
  };

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Bundles</h1>
      </div>
      <p className="muted small">
        Two or three products sold together for less. The saving comes off by itself whenever a cart holds the full set,
        and product pages offer &ldquo;Add bundle&rdquo;. Coupons apply on top. Products with sizes or colours
        can&apos;t be in a bundle.
      </p>
      {error && <p className="error">{error.message}</p>}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && <p role="status">{state.done}</p>}
      {data?.items.length === 0 && <p className="muted">No bundles yet.</p>}
      {data?.items.length > 0 && (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Bundle</th>
                <th className="num">Apart</th>
                <th className="num">Bundle</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((b) => (
                <tr key={b.id}>
                  <td>
                    <strong>{b.name}</strong>
                    <span className="muted small block">{b.products.map((p) => p.title).join(' + ')}</span>
                  </td>
                  <td className="num">{formatPrice(b.regular)}</td>
                  <td className="num">
                    {formatPrice(b.price)}
                    <span className="muted small block">
                      {b.saving > 0 ? `saves ${formatPrice(b.saving)}` : 'saves nothing now'}
                    </span>
                  </td>
                  <td>{b.active ? 'Shown' : 'Off'}</td>
                  <td>
                    <div className="admin-head-actions">
                      <button type="button" className="link" disabled={state.busy} onClick={() => changePrice(b)}>
                        Change price<span className="sr-only"> of {b.name}</span>
                      </button>
                      <button
                        type="button"
                        className="link"
                        disabled={state.busy}
                        onClick={() =>
                          run(
                            () => request(`/admin/bundles/${b.id}`, { method: 'PATCH', body: { active: !b.active } }),
                            b.active ? `“${b.name}” switched off.` : `“${b.name}” switched on.`,
                          )
                        }
                      >
                        {b.active ? 'Switch off' : 'Switch on'}
                        <span className="sr-only"> {b.name}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form key={formKey} className="sale-form" onSubmit={create} aria-labelledby="new-bundle-heading">
        <h2 id="new-bundle-heading">New bundle</h2>
        <label>
          Name
          <input name="name" required minLength={2} maxLength={60} placeholder="Mixer + extra jar" />
        </label>
        <Picker chosen={chosen} onChange={setChosen} />
        <label>
          Bundle price (₹){chosen.length > 1 && <span className="muted small"> · {formatPrice(regular)} apart</span>}
          <input name="price" type="number" min="1" step="1" required />
        </label>
        <button type="submit" className="btn primary" disabled={state.busy || chosen.length < 2}>
          Add bundle
        </button>
      </form>
    </section>
  );
}
