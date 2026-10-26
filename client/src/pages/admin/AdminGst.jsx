import { useState } from 'react';
import { request } from '../../api.js';
import { useFetch } from '../../useFetch.js';

// Admin → GST: the store's GST details and each category's rate and HSN code. Orders placed while GST is on get tax
// invoices; orders already placed keep the invoice they had.
function GstForm({ saved, onSaved }) {
  const [state, setState] = useState({ busy: false, error: null });

  async function submit(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const rateOf = (value) => (value === '' ? null : Number(value));
    setState({ busy: true, error: null });
    try {
      const body = {
        enabled: form.get('enabled') === 'on',
        gstin: form.get('gstin'),
        legalName: form.get('legalName'),
        address: form.get('address'),
        state: form.get('state'),
        defaultRate: rateOf(form.get('defaultRate')),
        categories: saved.categories.map((c) => ({
          id: c.id,
          rate: rateOf(form.get(`rate-${c.id}`)),
          hsn: form.get(`hsn-${c.id}`),
        })),
      };
      // Remounts this form with what was stored, so no state to reset here.
      onSaved(await request('/admin/gst', { method: 'PUT', body }));
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  const rateOptions = (empty) => (
    <>
      <option value="">{empty}</option>
      {saved.rates.map((r) => (
        <option key={r} value={r}>
          {r}%
        </option>
      ))}
    </>
  );

  return (
    <form className="admin-form gst-form" onSubmit={submit}>
      <label className="check">
        <input name="enabled" type="checkbox" defaultChecked={saved.enabled} />
        GST invoices: orders placed from now on get a tax invoice with your GSTIN and each line&apos;s tax
      </label>

      <fieldset>
        <legend>Your business</legend>
        <label>
          GSTIN
          <input
            name="gstin"
            defaultValue={saved.gstin}
            maxLength={15}
            placeholder="29ABCDE1234F1Z5"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </label>
        <label>
          Business name (as registered)
          <input name="legalName" defaultValue={saved.legalName} maxLength={120} />
        </label>
        <label className="wide">
          Address (as registered)
          <textarea name="address" rows={3} defaultValue={saved.address} maxLength={400} />
        </label>
        <label>
          State
          <select name="state" defaultValue={saved.state}>
            <option value="">Choose…</option>
            {saved.states.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Default rate
          <select name="defaultRate" defaultValue={saved.defaultRate ?? ''}>
            {rateOptions('Choose…')}
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>Rates by category</legend>
        <p className="muted small wide">
          Products use their category&apos;s rate, or the default. Prices include GST, so they don&apos;t change: the
          invoice shows how much of each price is tax. Delivery is taxed at the order&apos;s highest rate. Ask your
          accountant which rate and HSN code apply.
        </p>
        <div className="table-wrap wide">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>GST rate</th>
                <th>HSN code</th>
              </tr>
            </thead>
            <tbody>
              {saved.categories.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>
                    <select name={`rate-${c.id}`} defaultValue={c.rate ?? ''} aria-label={`GST rate for ${c.name}`}>
                      {rateOptions('Default')}
                    </select>
                  </td>
                  <td>
                    <input
                      name={`hsn-${c.id}`}
                      defaultValue={c.hsn}
                      inputMode="numeric"
                      maxLength={8}
                      size={9}
                      aria-label={`HSN code for ${c.name}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </fieldset>

      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={state.busy}>
          Save
        </button>
      </div>
    </form>
  );
}

export default function AdminGst() {
  const { data, error } = useFetch('/admin/gst');
  // What the last save returned; the form is remounted with it so it shows what was stored ("karnataka" → Karnataka).
  const [saved, setSaved] = useState(null);
  const current = saved ?? data;

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>GST</h1>
      </div>
      <p className="muted small">
        For a store registered for GST. Orders keep the details they were placed with, so changing anything here
        doesn&apos;t change invoices already made.
      </p>
      {error && <p className="error">{error.message}</p>}
      {saved && (
        <p className="notice" role="status">
          Saved. {saved.enabled ? 'Orders placed from now on get tax invoices.' : 'GST invoices are off.'}
        </p>
      )}
      {current && <GstForm key={JSON.stringify(current)} saved={current} onSaved={setSaved} />}
    </section>
  );
}
