import { useState } from 'react';
import { request } from '../../api.js';
import { useFetch } from '../../useFetch.js';

// Cash on Delivery's rules (stage 79): the largest order paid on delivery, and after how many refused or unreachable
// COD orders a customer must pay online. An empty box switches that rule off.
function CodRules() {
  const [version, setVersion] = useState(0);
  const { data } = useFetch('/admin/cod', version);
  const [state, setState] = useState({ busy: false, error: null, done: null });
  if (!data) return null;

  async function save(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null, done: null });
    try {
      await request('/admin/cod', {
        method: 'PUT',
        body: {
          maxOrder: f.maxOrder === '' ? null : Math.round(Number(f.maxOrder) * 100),
          refusedLimit: f.refusedLimit === '' ? null : Number(f.refusedLimit),
        },
      });
      setState({ busy: false, error: null, done: 'Saved.' });
      setVersion((v) => v + 1);
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
    }
  }

  return (
    <form key={JSON.stringify(data)} className="panel delivery-rule" onSubmit={save} aria-labelledby="cod-rules">
      <h2 id="cod-rules">Cash on Delivery</h2>
      <p className="muted small">
        Orders over the limit, and customers whose Cash on Delivery orders came back refused or unreachable that many
        times, must pay online. Leave a box empty for no limit. A customer can be allowed again from their page under
        Customers.
      </p>
      <div className="address-grid">
        <label>
          Largest order paid on delivery (₹)
          <input
            name="maxOrder"
            type="number"
            min="100"
            step="1"
            defaultValue={data.maxOrder === null ? '' : data.maxOrder / 100}
            placeholder="No limit"
          />
        </label>
        <label>
          Pay online only after this many refused
          <input
            name="refusedLimit"
            type="number"
            min="1"
            max="10"
            step="1"
            defaultValue={data.refusedLimit ?? ''}
            placeholder="Never"
          />
        </label>
      </div>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && <p role="status">{state.done}</p>}
      <button type="submit" className="btn primary" disabled={state.busy}>
        Save
      </button>
    </form>
  );
}

// Gift wrapping (stage 104): offered at checkout for a fee, or not. Gift messages are always free.
function GiftWrap() {
  const [version, setVersion] = useState(0);
  const { data } = useFetch('/admin/gift-wrap', version);
  const [state, setState] = useState({ busy: false, error: null, done: null });
  if (!data) return null;

  async function save(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null, done: null });
    try {
      await request('/admin/gift-wrap', {
        method: 'PUT',
        body: { enabled: f.enabled === 'on', fee: Math.round(Number(f.fee) * 100) },
      });
      setState({ busy: false, error: null, done: 'Saved.' });
      setVersion((v) => v + 1);
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
    }
  }

  return (
    <form key={JSON.stringify(data)} className="panel delivery-rule" onSubmit={save} aria-labelledby="gift-wrap">
      <h2 id="gift-wrap">Gift wrapping</h2>
      <p className="muted small">
        Customers can always mark an order as a gift and add a message for the packing slip. With this on, they can also
        have it gift wrapped for the fee below, which is added to the order like delivery.
      </p>
      <label className="check">
        <input name="enabled" type="checkbox" defaultChecked={data.enabled} />
        Offer gift wrapping at checkout
      </label>
      <label>
        Fee (₹)
        <input name="fee" type="number" min="1" max="500" step="1" required defaultValue={data.fee / 100} />
      </label>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && <p role="status">{state.done}</p>}
      <button type="submit" className="btn primary" disabled={state.busy}>
        Save
      </button>
    </form>
  );
}

// The rule's numbers from a form: delivered in min–max days, or not delivered.
function ruleFrom(form) {
  const f = Object.fromEntries(new FormData(form));
  const deliverable = f.deliverable === 'yes';
  return deliverable
    ? {
        deliverable,
        minDays: Number(f.minDays),
        maxDays: Number(f.maxDays),
        // Rupees in the form; paise for the API (stage 111).
        extraCharge: Math.round(Number(f.extraCharge || 0) * 100),
      }
    : { deliverable, minDays: 0, maxDays: 0 };
}

const describe = (r) =>
  r.deliverable
    ? `${r.minDays === r.maxDays ? `${r.minDays} days` : `${r.minDays}–${r.maxDays} days`}${
        r.extraCharge ? `, +₹${(r.extraCharge / 100).toLocaleString('en-IN')} delivery` : ''
      }`
    : 'Not delivered';

// The yes/no and days fields shared by the "everywhere else" rule and the areas.
function RuleFields({ rule, id }) {
  const [deliverable, setDeliverable] = useState(rule?.deliverable ?? true);
  return (
    <>
      <label>
        Delivered?
        <select
          name="deliverable"
          value={deliverable ? 'yes' : 'no'}
          onChange={(e) => setDeliverable(e.target.value === 'yes')}
          aria-label={`Delivered? (${id})`}
        >
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </label>
      {deliverable && (
        <>
          <label>
            Fastest, days
            <input name="minDays" type="number" min="0" max="30" required defaultValue={rule?.minDays ?? 2} />
          </label>
          <label>
            Slowest, days
            <input name="maxDays" type="number" min="0" max="30" required defaultValue={rule?.maxDays ?? 5} />
          </label>
          <label>
            Extra charge (₹)
            <input
              name="extraCharge"
              type="number"
              min="0"
              max="500"
              step="1"
              defaultValue={rule?.extraCharge ? rule.extraCharge / 100 : ''}
              placeholder="None"
            />
          </label>
        </>
      )}
    </>
  );
}

// Where the store delivers and how fast: areas by the first digits of the PIN code (the longest match wins), and a
// rule for everywhere else. Customers see it on product pages; checkout refuses PINs that aren't delivered to.
export default function AdminDelivery() {
  const [version, setVersion] = useState(0);
  const { data, error } = useFetch('/admin/delivery', version);
  const [state, setState] = useState({ busy: false, error: null, done: null });

  async function run(change, done) {
    setState({ busy: true, error: null, done: null });
    try {
      await change();
      setState({ busy: false, error: null, done });
      setVersion((v) => v + 1);
      return true;
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
      return false;
    }
  }

  function saveDefault(e) {
    e.preventDefault();
    const body = ruleFrom(e.currentTarget);
    run(() => request('/admin/delivery/everywhere-else', { method: 'PUT', body }), 'Saved');
  }

  async function addZone(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form));
    const body = { prefix: f.prefix.trim(), name: f.name.trim(), ...ruleFrom(form) };
    if (await run(() => request('/admin/delivery/zones', { method: 'POST', body }), `Added ${body.prefix}`))
      form.reset();
  }

  const remove = (z) =>
    window.confirm(`Remove the area for PIN codes starting ${z.prefix}?`) &&
    run(() => request(`/admin/delivery/zones/${z.id}`, { method: 'DELETE' }), `Removed ${z.prefix}`);

  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  return (
    <div className="admin-form">
      <section className="panel">
        <div className="admin-head">
          <h1>Delivery</h1>
        </div>
        <p className="muted small">
          Customers check their PIN code on product pages, and checkout refuses PIN codes you don&rsquo;t deliver to. An
          area covers every PIN code starting with its digits (e.g. 560 for Bengaluru); the longest match wins, and
          everything else follows the rule below.
        </p>
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        {state.done && <p role="status">{state.done}</p>}
        {data.zones.length === 0 ? (
          <p className="muted">No areas yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>PIN codes starting</th>
                  <th>Area</th>
                  <th>Delivery</th>
                  <th>
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.zones.map((z) => (
                  <tr key={z.id}>
                    <td>
                      <strong>{z.prefix}</strong>
                    </td>
                    <td>{z.name || '—'}</td>
                    <td>{describe(z)}</td>
                    <td>
                      <button type="button" className="link danger" onClick={() => remove(z)} disabled={state.busy}>
                        Remove<span className="sr-only"> {z.prefix}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <form className="panel delivery-rule" onSubmit={addZone} aria-labelledby="add-area">
        <h2 id="add-area">Add an area</h2>
        <div className="delivery-fields">
          <label>
            PIN codes starting
            <input
              name="prefix"
              required
              inputMode="numeric"
              pattern="[1-9][0-9]{0,5}"
              maxLength={6}
              title="1–6 digits"
            />
          </label>
          <label>
            Area name (optional)
            <input name="name" maxLength={40} placeholder="e.g. Bengaluru" />
          </label>
          <RuleFields id="new area" />
          <button type="submit" className="btn primary" disabled={state.busy}>
            Add area
          </button>
        </div>
      </form>

      <form
        key={JSON.stringify(data.everywhereElse)}
        className="panel delivery-rule"
        onSubmit={saveDefault}
        aria-labelledby="everywhere-else"
      >
        <h2 id="everywhere-else">Everywhere else</h2>
        <p className="muted small">Now: {describe(data.everywhereElse)}</p>
        <div className="delivery-fields">
          <RuleFields rule={data.everywhereElse} id="everywhere else" />
          <button type="submit" className="btn primary" disabled={state.busy}>
            Save
          </button>
        </div>
      </form>
      <CodRules />
      <GiftWrap />
    </div>
  );
}
