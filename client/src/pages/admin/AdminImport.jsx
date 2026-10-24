import { useState } from 'react';
import { Link } from 'react-router';
import { formatPrice } from '../../format.js';

const FIELDS = {
  title: 'Title',
  brand: 'Brand',
  category: 'Category',
  price: 'Price',
  mrp: 'MRP',
  stock: 'Stock',
  active: 'Shown',
  highlights: 'Highlights',
  description: 'Description',
};

function show(field, value) {
  if (value === undefined || value === '') return '(empty)';
  if (field === 'price' || field === 'mrp') return formatPrice(value);
  if (field === 'active') return value ? 'yes' : 'no';
  if (field === 'highlights') return value.join(' | ') || '(none)';
  if (field === 'description' && value.length > 60) return `${value.slice(0, 60)}…`;
  return String(value);
}

// "Price ₹349 → ₹1,299.50", or "Price ₹299" for a new product.
const change = (c) =>
  'from' in c
    ? `${FIELDS[c.field]} ${show(c.field, c.from)} → ${show(c.field, c.to)}`
    : `${FIELDS[c.field]} ${show(c.field, c.to)}`;

// Sends the chosen file's text as it is; `plan` saves what the preview showed.
async function sendCsv(path, text) {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function Preview({ preview }) {
  const { summary, rows, ignored } = preview;
  const listed = rows.filter((r) => r.action !== 'same');
  const parts = [
    summary.new && `${summary.new} new`,
    summary.update && `${summary.update} changed`,
    summary.same && `${summary.same} unchanged`,
    summary.error && `${summary.error} with problems`,
  ].filter(Boolean);
  return (
    <>
      <p>
        <strong>{parts.join(' · ')}</strong> ({rows.length} {rows.length === 1 ? 'row' : 'rows'})
      </p>
      {ignored.length > 0 && <p className="muted small">Columns not used: {ignored.join(', ')}.</p>}
      {listed.length > 0 && (
        <div className="table-wrap">
          <table className="admin-table import-table">
            <thead>
              <tr>
                <th className="num">Row</th>
                <th>Product</th>
                <th>What happens</th>
              </tr>
            </thead>
            <tbody>
              {listed.map((r) => (
                <tr key={r.row} className={r.action === 'error' ? 'import-error' : undefined}>
                  <td className="num">{r.row}</td>
                  <td>
                    {r.title || r.slug || '(no title)'}
                    {r.variant && <span className="muted small block">{r.variant}</span>}
                  </td>
                  <td>
                    {r.action === 'error' ? (
                      <span className="error">{r.error}</span>
                    ) : (
                      <>
                        {r.action === 'new' && <span className="status delivered">New</span>}{' '}
                        {r.changes.map(change).join(' · ')}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function AdminImport() {
  // `text` is the chosen file; `preview` what the server says it does; `saved` the result of saving it.
  const [state, setState] = useState({ text: null, preview: null, saved: null, busy: false, error: null });
  // Remounts the file input after a save, so the same file can be chosen again.
  const [inputKey, setInputKey] = useState(0);
  const { preview } = state;
  const canSave = preview && !preview.summary.error && (preview.summary.new || preview.summary.update);

  async function choose(e) {
    const file = e.target.files[0];
    setState({ text: null, preview: null, saved: null, busy: Boolean(file), error: null });
    if (!file) return;
    try {
      const text = await file.text();
      setState({ text, preview: await sendCsv('/admin/products/import', text), saved: null, busy: false, error: null });
    } catch (err) {
      setState({ text: null, preview: null, saved: null, busy: false, error: err.message });
    }
  }

  async function save() {
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const saved = await sendCsv(`/admin/products/import/save?plan=${preview.plan}`, state.text);
      setState({ text: null, preview: null, saved, busy: false, error: null });
      setInputKey((k) => k + 1);
    } catch (err) {
      setState((s) => ({ ...s, busy: false, error: err.message }));
    }
  }

  async function checkAgain() {
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const fresh = await sendCsv('/admin/products/import', state.text);
      setState((s) => ({ ...s, preview: fresh, busy: false }));
    } catch (err) {
      setState((s) => ({ ...s, busy: false, error: err.message }));
    }
  }

  return (
    <section className="panel import-page">
      <div className="admin-head">
        <h1>Import products</h1>
        <Link to="/admin/products">Back to products</Link>
      </div>

      <h2>1. Download the products</h2>
      <p className="muted small">
        A CSV file for Excel or Google Sheets with every product, shown or hidden. A product with sizes or colours has a
        row for each, below it, with its own price, MRP and stock. Download a fresh copy just before editing: the stock
        in the file replaces the stock in the store.
      </p>
      <a className="btn small" href="/api/admin/products/export" download>
        Download products CSV
      </a>

      <h2>2. Edit and upload it</h2>
      <ul className="muted small import-help">
        <li>Change any cell; an empty cell keeps what the store has. Rows you don&apos;t change can stay.</li>
        <li>Add a product on a row with no slug: it needs a title, brand, category, price, MRP and stock.</li>
        <li>Prices are in rupees (1499 or 1,499.50). Shown is yes or no. Separate highlights with |, up to 8.</li>
        <li>Photos, and adding sizes or colours, are done in the product form.</li>
      </ul>
      <label className="import-file">
        CSV file
        <input key={inputKey} type="file" accept=".csv,text/csv" onChange={choose} disabled={state.busy} />
      </label>

      {state.busy && !preview && <p className="muted">Checking…</p>}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.saved && (
        <p className="notice" role="status">
          Saved: {state.saved.added} added, {state.saved.updated} updated.{' '}
          <Link to="/admin/products">See the products</Link>
        </p>
      )}

      {preview && (
        <section aria-labelledby="import-preview">
          <h2 id="import-preview">3. Check and save</h2>
          <Preview preview={preview} />
          {preview.summary.error > 0 && (
            <p className="muted small">
              Fix the rows with problems in the file and choose it again. Nothing was saved.
            </p>
          )}
          <div className="buy-buttons">
            <button type="button" className="btn primary" disabled={!canSave || state.busy} onClick={save}>
              {canSave
                ? `Save ${preview.summary.new + preview.summary.update} ${preview.summary.new + preview.summary.update === 1 ? 'row' : 'rows'}`
                : 'Nothing to save'}
            </button>
            {state.error && (
              <button type="button" className="btn" disabled={state.busy} onClick={checkAgain}>
                Check again
              </button>
            )}
          </div>
        </section>
      )}
    </section>
  );
}
