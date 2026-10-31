import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { query, request } from '../../api.js';
import Pager from '../../components/Pager.jsx';
import { formatDate } from '../../format.js';
import { useFetch } from '../../useFetch.js';
import NotFound from '../NotFound.jsx';

// Stocktake (stage 98): count the shelves, check the differences, save them as "Stocktake" in the stock history.
// "On the shelf" includes units sold but not shipped yet, which the stock figure has already taken off.

// With a sign, and a real minus like the stock history.
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
const rowKey = (r) => `${r.productId}.${r.variantId ?? ''}`;
const rowTitle = (r) => (r.label ? `${r.title} (${r.label})` : r.title);

// /admin/stocktakes: earlier counts, and starting a new one for a category or the whole store.
export function AdminStocktakes() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const navigate = useNavigate();
  const { data, error, loading } = useFetch(`/admin/stocktakes${query({ page: page > 1 ? page : '' })}`);
  const { data: categories } = useFetch('/admin/categories');
  return (
    <section className="panel">
      <h1>Stocktake</h1>
      <p className="muted small">
        Count what is on the shelves and put the stock right. Print a count sheet, count, type the numbers in, check the
        differences, then save: each change shows as &ldquo;Stocktake&rdquo; in the product&apos;s stock history.
      </p>
      <form
        className="admin-filters"
        onSubmit={(e) => {
          e.preventDefault();
          const category = new FormData(e.currentTarget).get('category');
          navigate(`/admin/stocktakes/new${query({ category })}`);
        }}
      >
        <select name="category" aria-label="What to count" defaultValue="">
          <option value="">All products</option>
          {categories?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button type="submit" className="btn primary">
          Start a count
        </button>
      </form>
      {error && <p className="error">{error.message}</p>}
      {data?.items.length === 0 && <p className="muted">No stocktakes yet.</p>}
      {data?.items.length > 0 && (
        <div className="table-wrap">
          <table className={`admin-table ${loading ? 'stale' : ''}`}>
            <thead>
              <tr>
                <th>Stocktake</th>
                <th>Counted</th>
                <th className="num">Rows</th>
                <th className="num">Changed</th>
                <th className="num">Difference</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/admin/stocktakes/${s.id}`}>#{s.number}</Link>
                    <span className="muted small block">
                      {formatDate(s.createdAt)} · {s.by}
                    </span>
                  </td>
                  <td>{s.category?.name ?? 'All products'}</td>
                  <td className="num">{s.counted}</td>
                  <td className="num">{s.changed}</td>
                  <td className="num">{signed(s.difference)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && (
        <Pager
          page={page}
          total={data.total}
          pageSize={data.pageSize}
          onPage={(p) => setParams(query({ page: p > 1 ? p : '' }).slice(1))}
        />
      )}
    </section>
  );
}

// Counts typed so far, kept in this browser per sheet so a reload or a walk to the shelves doesn't lose them.
const draftKey = (category) => `bazaar.stocktake.${category || 'all'}`;
function readDraft(category) {
  try {
    return JSON.parse(localStorage.getItem(draftKey(category))) ?? {};
  } catch {
    return {};
  }
}
function writeDraft(category, counts) {
  try {
    if (Object.keys(counts).length) localStorage.setItem(draftKey(category), JSON.stringify(counts));
    else localStorage.removeItem(draftKey(category));
  } catch {
    // Storage blocked: the counts still work on this page.
  }
}

// /admin/stocktakes/new?category=: the count sheet. "On the shelf" isn't printed, so the count isn't led by it.
export function AdminStocktakeNew() {
  const [params] = useSearchParams();
  const category = params.get('category') ?? '';
  const navigate = useNavigate();
  const { data, error } = useFetch(`/admin/stocktakes/sheet${query({ category })}`);
  const [counts, setCounts] = useState(() => readDraft(category));
  const [state, setState] = useState({ busy: false, error: null, preview: null });

  if (error?.status === 404 || error?.status === 400) return <NotFound message={error.message} />;
  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const lines = data.rows
    .filter((r) => (counts[rowKey(r)] ?? '') !== '')
    .map((r) => ({
      productId: r.productId,
      ...(r.variantId && { variantId: r.variantId }),
      counted: Number(counts[rowKey(r)]),
    }));
  const results = new Map((state.preview?.rows ?? []).map((r) => [rowKey(r), r]));
  const change = (r, value) => {
    const next = { ...counts, [rowKey(r)]: value };
    if (value === '') delete next[rowKey(r)];
    setCounts(next);
    writeDraft(category, next);
    setState({ busy: false, error: null, preview: null }); // a changed count needs a new check
  };

  async function send(e) {
    e.preventDefault();
    const preview = !state.preview;
    const note = new FormData(e.currentTarget).get('note');
    setState({ ...state, busy: true, error: null });
    try {
      const result = await request('/admin/stocktakes', {
        method: 'POST',
        body: { category: category || null, note, lines, preview },
      });
      if (preview) {
        setState({ busy: false, error: null, preview: result.preview });
      } else {
        writeDraft(category, {});
        navigate(`/admin/stocktakes/${result.id}`);
      }
    } catch (err) {
      setState({ busy: false, error: err.message, preview: null });
    }
  }

  const p = state.preview;
  const title = `Count sheet: ${data.category?.name ?? 'All products'}`;
  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/admin/stocktakes">Stocktake</Link>
        <span aria-hidden>›</span>
        <span>{data.category?.name ?? 'All products'}</span>
      </nav>
      <form className="panel stocktake" onSubmit={send} aria-label={title}>
        <div className="admin-head">
          <h1>{title}</h1>
          <button type="button" className="btn no-print" onClick={() => window.print()}>
            Print count sheet
          </button>
        </div>
        <p className="muted small no-print">
          Leave a row empty if you didn&apos;t count it: it stays as it is. &ldquo;On the shelf&rdquo; includes items
          sold but not shipped yet, so don&apos;t ship orders between counting and saving.
        </p>
        <p className="print-only small">Counted by: ____________________ Date: ____________</p>
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Product</th>
                <th className="num no-print">On the shelf</th>
                <th className="num">Counted</th>
                {p && <th className="num">Difference</th>}
                {p && <th className="num">Stock after</th>}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const result = results.get(rowKey(r));
                return (
                  <tr key={rowKey(r)}>
                    <td>
                      {rowTitle(r)}
                      {!r.active && <span className="muted small"> · hidden</span>}
                      {r.sku && <span className="slip-sku">SKU {r.sku}</span>}
                      {r.reserved > 0 && (
                        <span className="muted small block no-print">{r.reserved} sold, waiting to ship</span>
                      )}
                    </td>
                    <td className="num no-print">{r.onShelf}</td>
                    <td className="num">
                      <input
                        type="number"
                        min="0"
                        max="100000"
                        step="1"
                        inputMode="numeric"
                        value={counts[rowKey(r)] ?? ''}
                        onChange={(e) => change(r, e.target.value)}
                        aria-label={`Counted: ${rowTitle(r)}`}
                        className="count-input"
                      />
                    </td>
                    {p && <td className="num">{result ? signed(result.difference) : ''}</td>}
                    {p && (
                      <td className="num">
                        {result && (result.stockAfter === r.stock ? r.stock : `${r.stock} → ${result.stockAfter}`)}
                        {result?.short > 0 && (
                          <span className="error small block">{result.short} short for waiting orders</span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="no-print stocktake-actions">
          {p && (
            <div className="notice" role="status">
              <p>
                {p.changed === 0
                  ? 'Everything counted matches. Saving records the count without changing any stock.'
                  : `${p.changed} ${p.changed === 1 ? 'row changes' : 'rows change'}: ${signed(p.difference)} ${Math.abs(p.difference) === 1 ? 'unit' : 'units'} against what should be on the shelf.`}
              </p>
            </div>
          )}
          <label>
            Note (optional)
            <input name="note" maxLength={500} placeholder="Shelf B, after the Diwali sale" />
          </label>
          {state.error && (
            <p className="error" role="alert">
              {state.error}
            </p>
          )}
          <button type="submit" className="btn primary" disabled={state.busy || lines.length === 0}>
            {p ? 'Save the count' : `Check ${lines.length} ${lines.length === 1 ? 'count' : 'counts'}`}
          </button>
        </div>
      </form>
    </>
  );
}

// /admin/stocktakes/:id: a saved count, printable.
export function AdminStocktake() {
  const { id } = useParams();
  const { data: s, error } = useFetch(`/admin/stocktakes/${id}`);
  if (error?.status === 404 || error?.status === 400) return <NotFound message="We couldn't find that stocktake." />;
  if (error) return <p className="error">{error.message}</p>;
  if (!s) return <p className="muted">Loading…</p>;
  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/admin/stocktakes">Stocktake</Link>
        <span aria-hidden>›</span>
        <span>#{s.number}</span>
      </nav>
      <section className="panel">
        <div className="admin-head">
          <h1>
            Stocktake #{s.number}: {s.category?.name ?? 'All products'}
          </h1>
          <button type="button" className="btn no-print" onClick={() => window.print()}>
            Print
          </button>
        </div>
        <p className="muted small">
          {formatDate(s.createdAt)} · counted by {s.by} · {s.counted} {s.counted === 1 ? 'row' : 'rows'}, {s.changed}{' '}
          changed, {signed(s.difference)} against what should have been on the shelf
        </p>
        {s.note && <p>{s.note}</p>}
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">On the shelf</th>
                <th className="num">Counted</th>
                <th className="num">Difference</th>
                <th className="num">Stock</th>
              </tr>
            </thead>
            <tbody>
              {s.lines.map((l) => (
                <tr key={`${l.productId}.${l.variantId ?? ''}`}>
                  <td>
                    <Link to={`/admin/products/${l.productId}/stock${l.variantId ? `?variant=${l.variantId}` : ''}`}>
                      {l.title}
                    </Link>
                    {l.short > 0 && <span className="error small block">{l.short} short for waiting orders</span>}
                  </td>
                  <td className="num">{l.onShelf}</td>
                  <td className="num">{l.counted}</td>
                  <td className="num">{signed(l.difference)}</td>
                  <td className="num">
                    {l.stockAfter === l.stockBefore ? l.stockAfter : `${l.stockBefore} → ${l.stockAfter}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
