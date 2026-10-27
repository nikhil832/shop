import { useState } from 'react';
import { query, request } from '../../api.js';
import { formatDate, formatTime } from '../../format.js';
import { useFetch } from '../../useFetch.js';

const STATUS = { upcoming: 'Upcoming', running: 'Running', ended: 'Ended', cancelled: 'Called off' };
const when = (iso) => `${formatDate(iso)}, ${formatTime(iso)}`;
// A datetime-local value (the admin's own time) from a Date.
const local = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

// Picks products for a sale by searching the catalog; `chosen` are { id, title }.
function ProductPicker({ chosen, onChange }) {
  const [q, setQ] = useState('');
  const { data } = useFetch(q.trim().length >= 2 ? `/admin/products${query({ q: q.trim() })}` : null);
  const add = (p) => !chosen.some((c) => c.id === p.id) && onChange([...chosen, { id: p.id, title: p.title }]);
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
              <span>{p.title}</span>
              <button
                type="button"
                className="link"
                disabled={chosen.some((c) => c.id === p.id)}
                onClick={() => add(p)}
              >
                Add<span className="sr-only"> {p.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {chosen.length > 0 && (
        <ul className="sale-chosen" aria-label="Products in the sale">
          {chosen.map((c) => (
            <li key={c.id}>
              {c.title}{' '}
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

// Scheduled sales (stage 67): a percentage off a category or chosen products, between two times. Prices change when
// the sale starts and go back when it ends (within a minute, while the server is awake).
export default function AdminSales() {
  const [version, setVersion] = useState(0);
  const { data, error } = useFetch('/admin/sales', version);
  const { data: categories } = useFetch('/categories');
  const [scope, setScope] = useState('category');
  const [chosen, setChosen] = useState([]);
  const [state, setState] = useState({ busy: false, error: null, done: null });
  const [formKey, setFormKey] = useState(0);

  async function run(action, done) {
    setState({ busy: true, error: null, done: null });
    try {
      await action();
      setState({ busy: false, error: null, done });
      setVersion((v) => v + 1);
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
    }
  }

  function create(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    const body = {
      name: f.name,
      percent: Number(f.percent),
      startsAt: new Date(f.startsAt).toISOString(),
      endsAt: new Date(f.endsAt).toISOString(),
      ...(scope === 'category' ? { categoryId: f.categoryId } : { productIds: chosen.map((c) => c.id) }),
    };
    run(async () => {
      const res = await request('/admin/sales', { method: 'POST', body });
      setChosen([]);
      setFormKey((k) => k + 1);
      return res;
    }, `“${f.name}” scheduled.`);
  }

  const now = new Date();
  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Sales</h1>
      </div>
      <p className="muted small">
        A percentage off a category or chosen products, from a start to an end. Prices drop when it starts and go back
        by themselves when it ends (on the free plan, at the next minute the server is awake). Customers watching a
        product get the usual price-drop email. While a product is on sale its prices can&apos;t be edited; stock can.
      </p>

      {error && <p className="error">{error.message}</p>}
      {data?.items.length === 0 && <p className="muted">No sales yet.</p>}
      {data?.items.length > 0 && (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Sale</th>
                <th>When</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.name}</strong> · {s.percent}% off
                    <span className="muted small block">
                      {s.covers}
                      {s.applied !== null && ` · ${s.applied} on sale`}
                      {s.skipped > 0 && `, ${s.skipped} already in another sale`}
                    </span>
                  </td>
                  <td className="small">
                    {when(s.startsAt)} to
                    <span className="block">{when(s.endsAt)}</span>
                  </td>
                  <td>
                    <span className={`status sale-${s.status}`}>{STATUS[s.status]}</span>
                  </td>
                  <td>
                    {(s.status === 'running' || s.status === 'upcoming') && (
                      <button
                        type="button"
                        className="link danger"
                        disabled={state.busy}
                        onClick={() =>
                          run(
                            () => request(`/admin/sales/${s.id}/end`, { method: 'POST' }),
                            s.status === 'running' ? `“${s.name}” ended; prices are back.` : `“${s.name}” called off.`,
                          )
                        }
                      >
                        {s.status === 'running' ? 'End now' : 'Call off'}
                        <span className="sr-only"> {s.name}</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form key={formKey} className="sale-form" onSubmit={create} aria-labelledby="new-sale-heading">
        <h2 id="new-sale-heading">New sale</h2>
        <div className="address-grid">
          <label>
            Name
            <input name="name" required maxLength={40} placeholder="Diwali sale" />
          </label>
          <label>
            Percent off
            <input name="percent" type="number" min="1" max="90" required defaultValue="10" />
          </label>
          <label>
            Starts
            <input name="startsAt" type="datetime-local" required defaultValue={local(now)} />
          </label>
          <label>
            Ends
            <input
              name="endsAt"
              type="datetime-local"
              required
              defaultValue={local(new Date(now.getTime() + 7 * 86_400_000))}
            />
          </label>
        </div>
        <fieldset className="sale-scope">
          <legend>On</legend>
          <label className="check">
            <input type="radio" checked={scope === 'category'} onChange={() => setScope('category')} />A whole category
          </label>
          <label className="check">
            <input type="radio" checked={scope === 'products'} onChange={() => setScope('products')} />
            Chosen products
          </label>
        </fieldset>
        {scope === 'category' ? (
          <label>
            Category
            <select name="categoryId" required defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              {categories?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <ProductPicker chosen={chosen} onChange={setChosen} />
        )}
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        {state.done && <p role="status">{state.done}</p>}
        <button type="submit" className="btn primary" disabled={state.busy}>
          Schedule sale
        </button>
      </form>
    </section>
  );
}
