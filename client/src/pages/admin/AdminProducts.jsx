import { useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { query, request } from '../../api.js';
import { formatPrice, smallImage } from '../../format.js';
import { useFetch } from '../../useFetch.js';
import { uploadSmallVersion } from '../../photos.js';
import Pager from '../../components/Pager.jsx';

const STATUSES = [
  ['', 'All'],
  ['active', 'Active'],
  ['hidden', 'Hidden'],
  ['low', 'Low stock (≤5)'],
];

// Stock can be changed right in the list. Remounted (key) when the saved value changes.
function StockForm({ product, onSaved }) {
  const [state, setState] = useState({ busy: false, error: null });
  async function submit(e) {
    e.preventDefault();
    const stock = Number(new FormData(e.currentTarget).get('stock'));
    setState({ busy: true, error: null });
    try {
      await request(`/admin/products/${product.id}`, { method: 'PATCH', body: { stock } });
      onSaved();
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }
  return (
    <form className="stock-form" onSubmit={submit}>
      <input
        name="stock"
        type="number"
        min="0"
        max="100000"
        step="1"
        required
        defaultValue={product.stock}
        aria-label={`Stock of ${product.title}`}
      />
      <button type="submit" className="btn small" disabled={state.busy}>
        Save
      </button>
      {state.error && <span className="error small">{state.error}</span>}
    </form>
  );
}

// Photos uploaded before stage 68 have no small version: this makes them in the browser, one at a time, from the full
// photos. Shown only while there are some.
function SmallVersions() {
  const { data } = useFetch('/admin/images/without-small');
  const [state, setState] = useState({ busy: false, done: 0, failed: 0, finished: false });
  if (!data?.urls.length || state.finished) {
    return state.finished ? (
      <p className="notice" role="status">
        Made {state.done} small {state.done === 1 ? 'version' : 'versions'}
        {state.failed > 0 && ` (${state.failed} couldn't be made)`}. Cards and lists now load faster.
      </p>
    ) : null;
  }

  async function makeAll() {
    let done = 0;
    let failed = 0;
    setState({ busy: true, done, failed, finished: false });
    for (const url of data.urls) {
      try {
        const blob = await (await fetch(url)).blob();
        if (await uploadSmallVersion(url.split('/').pop(), blob)) done += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
      setState({ busy: true, done, failed, finished: false });
    }
    setState({ busy: false, done, failed, finished: true });
  }

  return (
    <p className="notice">
      {data.urls.length} product {data.urls.length === 1 ? 'photo has' : 'photos have'} no small version yet, so cards
      and lists load the full photo.{' '}
      <button type="button" className="btn small" onClick={makeAll} disabled={state.busy}>
        {state.busy ? `Making… ${state.done + state.failed} of ${data.urls.length}` : 'Make small versions'}
      </button>
    </p>
  );
}

export default function AdminProducts() {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [version, setVersion] = useState(0);
  const q = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const status = params.get('status') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const { data: categories } = useFetch('/admin/categories');
  const { data, error, loading } = useFetch(
    `/admin/products${query({ q, category, status, page: page > 1 ? page : '' })}`,
    version,
  );
  const refresh = () => setVersion((v) => v + 1);
  const categoryName = new Map(categories?.map((c) => [c.id, c.name]));

  const update = (changes) => {
    const next = { q, category, status, ...changes };
    setParams(query({ ...next, page: changes.page > 1 ? changes.page : '' }).slice(1));
  };

  async function setActive(product, active) {
    await request(`/admin/products/${product.id}`, { method: 'PATCH', body: { active } });
    refresh();
  }

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Products</h1>
        <div className="admin-head-actions">
          <Link to="/admin/products/import" className="btn small">
            Import / export CSV
          </Link>
          <Link to="/admin/products/new" className="btn primary small">
            Add product
          </Link>
        </div>
      </div>
      <SmallVersions />
      {location.state?.saved && (
        <p className="notice" role="status">
          Saved “{location.state.saved}”.
        </p>
      )}

      <div className="admin-filters">
        <form
          key={q}
          className="admin-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: new FormData(e.currentTarget).get('q').trim() });
          }}
        >
          <input
            name="q"
            type="search"
            defaultValue={q}
            placeholder="Title, brand or slug"
            aria-label="Find products"
          />
          <button type="submit" className="btn small">
            Find
          </button>
        </form>
        <select value={category} onChange={(e) => update({ category: e.target.value })} aria-label="Category">
          <option value="">All categories</option>
          {categories?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => update({ status: e.target.value })} aria-label="Status">
          {STATUSES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {data && <span className="muted">{data.total} products</span>}
      </div>

      {error && <p className="error">{error.message}</p>}
      {data?.items.length === 0 && <p className="muted">No products match.</p>}
      {data?.items.length > 0 && (
        <div className={`table-wrap ${loading ? 'stale' : ''}`}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                <th className="num">Price</th>
                <th>Stock</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id} className={p.active ? '' : 'inactive'}>
                  <td>
                    <div className="product-cell">
                      <img src={smallImage(p.images[0])} alt="" width="44" height="44" />
                      <span>
                        <Link to={`/admin/products/${p.id}`}>{p.title}</Link>
                        <span className="muted small block">{p.brand}</span>
                      </span>
                    </div>
                  </td>
                  <td>{categoryName.get(p.categoryId) ?? '—'}</td>
                  <td className="num">
                    {p.variants.length > 0 && <span className="muted small">from </span>}
                    {formatPrice(p.price)}
                    {p.mrp > p.price && <s className="muted small block">{formatPrice(p.mrp)}</s>}
                  </td>
                  <td>
                    {/* With variants, stock is per variant: edited on the product's page. */}
                    {p.variants.length > 0 ? (
                      <span className="small">
                        {p.stock} in {p.variants.length}{' '}
                        {p.options.length > 1 ? 'combinations' : `${p.variantName.toLowerCase()}s`}
                        <span className="muted block">
                          {p.variants.map((v) => `${v.label}: ${v.stock}`).join(' · ')}
                        </span>
                      </span>
                    ) : (
                      <StockForm key={`${p.id}:${p.stock}`} product={p} onSaved={refresh} />
                    )}
                  </td>
                  <td>
                    <div className="status-cell">
                      <span className={`status ${p.active ? 'placed' : 'cancelled'}`}>
                        {p.active ? 'Active' : 'Hidden'}
                      </span>
                      {p.comingSoon && p.stock === 0 && <span className="muted small">Coming soon</span>}
                      <button type="button" className="link" onClick={() => setActive(p, !p.active)}>
                        {p.active ? 'Hide' : 'Show'}
                        <span className="sr-only"> {p.title}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={(n) => update({ page: n })} />}
    </section>
  );
}
