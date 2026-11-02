import { useState } from 'react';
import { request } from '../../api.js';
import { formatDate, formatPrice, toPaise } from '../../format.js';
import { useFetch } from '../../useFetch.js';

export const describeCoupon = (c) =>
  c.type === 'free_delivery'
    ? 'Free delivery'
    : c.type === 'percent'
      ? `${c.value}% off${c.maxDiscount ? ` (up to ${formatPrice(c.maxDiscount)})` : ''}`
      : `${formatPrice(c.value)} off`;

const conditions = (c) =>
  [
    c.minSubtotal > 0 && `Orders from ${formatPrice(c.minSubtotal)}`,
    c.expiresAt && `${new Date(c.expiresAt) <= new Date() ? 'Ended' : 'Ends'} ${formatDate(c.expiresAt)}`,
  ]
    .filter(Boolean)
    .join(' · ') || '—';

// The form's rupee and date fields, turned into what the API takes (paise, an end-of-day date, numbers or null).
function couponBody(form) {
  const f = Object.fromEntries(new FormData(form));
  const optional = (value, convert) => (value === '' || value === undefined ? null : convert(value));
  return {
    code: f.code,
    type: f.type,
    value: f.type === 'percent' ? Number(f.value) : f.type === 'flat' ? toPaise(f.value) : 0,
    maxDiscount: f.type === 'percent' ? optional(f.maxDiscount, toPaise) : null,
    minSubtotal: optional(f.minSubtotal, toPaise) ?? 0,
    // The last day it works: until the end of that day, local time.
    expiresAt: optional(f.expiresAt, (d) => new Date(`${d}T23:59:59`).toISOString()),
    usageLimit: optional(f.usageLimit, Number),
  };
}

// Cashback (stage 85): store credit for orders kept past their return window. Off until switched on; only orders
// placed from then earn it.
function Cashback() {
  const [version, setVersion] = useState(0);
  const { data } = useFetch('/admin/cashback', version);
  const [state, setState] = useState({ busy: false, error: null, done: null });
  if (!data) return null;
  async function save(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null, done: null });
    try {
      await request('/admin/cashback', {
        method: 'PUT',
        body: { enabled: f.enabled === 'on', percent: Number(f.percent), cap: Math.round(Number(f.cap) * 100) },
      });
      setState({ busy: false, error: null, done: 'Saved.' });
      setVersion((v) => v + 1);
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
    }
  }
  return (
    <form key={JSON.stringify(data)} className="panel" onSubmit={save} aria-labelledby="cashback-heading">
      <h2 id="cashback-heading">Cashback</h2>
      <p className="muted small">
        A percentage of what each delivered order paid for the items kept comes back as store credit once its 7-day
        return window has passed. Only orders placed after it&apos;s switched on earn it.
        {data.since && ` On since ${new Date(data.since).toLocaleDateString('en-IN')}.`} Paid so far:{' '}
        {formatPrice(data.paid.total)} on {data.paid.orders} {data.paid.orders === 1 ? 'order' : 'orders'}.
      </p>
      <label className="check">
        <input name="enabled" type="checkbox" defaultChecked={data.enabled} />
        Give cashback
      </label>
      <div className="address-grid">
        <label>
          Percent back
          <input name="percent" type="number" min="1" max="20" step="1" required defaultValue={data.percent} />
        </label>
        <label>
          At most per order (₹)
          <input name="cap" type="number" min="1" step="1" required defaultValue={data.cap / 100} />
        </label>
      </div>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && <p role="status">{state.done}</p>}
      <button type="submit" className="btn primary" disabled={state.busy}>
        Save cashback
      </button>
    </form>
  );
}

// A free gift with orders over an amount (stage 149): a product without options, optionally between two days. Off
// until switched on; each order gets one while any are left.
function FreeGift() {
  const [version, setVersion] = useState(0);
  const { data } = useFetch('/admin/free-gift', version);
  const [state, setState] = useState({ busy: false, error: null, done: null });
  if (!data) return null;
  async function save(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null, done: null });
    try {
      await request('/admin/free-gift', {
        method: 'PUT',
        body: {
          enabled: f.enabled === 'on',
          productId: f.productId || null,
          minSubtotal: Math.round(Number(f.minSubtotal) * 100),
          from: f.from || null,
          to: f.to || null,
        },
      });
      setState({ busy: false, error: null, done: 'Saved.' });
      setVersion((v) => v + 1);
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
    }
  }
  return (
    <form key={JSON.stringify(data)} className="panel" onSubmit={save} aria-labelledby="free-gift-heading">
      <h2 id="free-gift-heading">Free gift</h2>
      <p className="muted small">
        Orders whose items come to the amount or more (after bundle and quantity savings, before coupons) get one of
        this product free, while any are in stock. The cart tells customers how much more they need.{' '}
        {data.live
          ? `On now, ${data.stock} left.`
          : data.enabled
            ? 'Switched on, but not shown right now (outside its days, or the product is hidden).'
            : 'Off.'}{' '}
        Given so far: {data.given}.
      </p>
      <label className="check">
        <input name="enabled" type="checkbox" defaultChecked={data.enabled} />
        Give a free gift
      </label>
      <div className="address-grid">
        <label>
          Gift
          <select name="productId" defaultValue={data.productId ?? ''}>
            <option value="">Choose a product</option>
            {data.choices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} ({p.stock} in stock)
              </option>
            ))}
          </select>
        </label>
        <label>
          For orders from (₹)
          <input name="minSubtotal" type="number" min="1" step="1" required defaultValue={data.minSubtotal / 100} />
        </label>
        <label>
          First day (optional)
          <input name="from" type="date" defaultValue={data.from ?? ''} />
        </label>
        <label>
          Last day (optional)
          <input name="to" type="date" defaultValue={data.to ?? ''} />
        </label>
      </div>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && <p role="status">{state.done}</p>}
      <button type="submit" className="btn primary" disabled={state.busy}>
        Save free gift
      </button>
    </form>
  );
}

// Birthday treat (stage 141): a one-use coupon of their own, emailed to customers on their birthday. Off until on.
function BirthdayTreat() {
  const [version, setVersion] = useState(0);
  const { data } = useFetch('/admin/birthday', version);
  const [state, setState] = useState({ busy: false, error: null, done: null });
  if (!data) return null;
  async function save(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null, done: null });
    try {
      await request('/admin/birthday', {
        method: 'PUT',
        body: {
          enabled: f.enabled === 'on',
          amount: Math.round(Number(f.amount) * 100),
          minOrder: Math.round(Number(f.minOrder) * 100),
          validDays: Number(f.validDays),
        },
      });
      setState({ busy: false, error: null, done: 'Saved.' });
      setVersion((v) => v + 1);
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
    }
  }
  return (
    <form key={JSON.stringify(data)} className="panel" onSubmit={save} aria-labelledby="birthday-heading">
      <h2 id="birthday-heading">Birthday treat</h2>
      <p className="muted small">
        Customers who saved their birthday on their account get an amount off by email on the day: a code of their own
        that works once. A newly saved or changed birthday counts from a month later, and nobody gets more than one a
        year. {data.withBirthday} {data.withBirthday === 1 ? 'customer has' : 'customers have'} saved a birthday; in the
        last year {data.lastYear.sent} sent, {data.lastYear.used} used.
      </p>
      <label className="check">
        <input name="enabled" type="checkbox" defaultChecked={data.enabled} />
        Give birthday treats
      </label>
      <div className="address-grid">
        <label>
          Amount off (₹)
          <input name="amount" type="number" min="1" step="1" required defaultValue={data.amount / 100} />
        </label>
        <label>
          On orders from (₹)
          <input name="minOrder" type="number" min="0" step="1" required defaultValue={data.minOrder / 100} />
        </label>
        <label>
          Valid for (days)
          <input name="validDays" type="number" min="1" max="60" step="1" required defaultValue={data.validDays} />
        </label>
      </div>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && <p role="status">{state.done}</p>}
      <button type="submit" className="btn primary" disabled={state.busy}>
        Save birthday treat
      </button>
    </form>
  );
}

// Loyalty levels (stage 134): Silver and Gold by a year's spending on delivered orders, each with its own
// free-delivery minimum and, since stage 136, extra cashback. Off until switched on.
function Loyalty() {
  const [version, setVersion] = useState(0);
  const { data } = useFetch('/admin/loyalty', version);
  const [state, setState] = useState({ busy: false, error: null, done: null });
  if (!data) return null;
  const paise = (v) => Math.round(Number(v) * 100);
  async function save(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null, done: null });
    try {
      await request('/admin/loyalty', {
        method: 'PUT',
        body: {
          enabled: f.enabled === 'on',
          silver: {
            spend: paise(f.silverSpend),
            freeDeliveryMin: paise(f.silverFree),
            extraCashback: Number(f.silverCashback),
          },
          gold: {
            spend: paise(f.goldSpend),
            freeDeliveryMin: paise(f.goldFree),
            extraCashback: Number(f.goldCashback),
          },
        },
      });
      setState({ busy: false, error: null, done: 'Saved.' });
      setVersion((v) => v + 1);
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
    }
  }
  return (
    <form key={JSON.stringify(data)} className="panel" onSubmit={save} aria-labelledby="loyalty-heading">
      <h2 id="loyalty-heading">Loyalty levels</h2>
      <p className="muted small">
        Customers become Silver or Gold by what they spent on delivered orders in the last 12 months (less refunds), and
        get free delivery from a lower amount than the usual {formatPrice(data.usualFreeDeliveryMin)}; 0 means free
        delivery on every order. Each level can also earn extra cashback on its orders, paid as store credit after the
        return window like the cashback above, even while that is off (it counts towards the same per-order limit). They
        see their level on their account page.
      </p>
      <label className="check">
        <input name="enabled" type="checkbox" defaultChecked={data.enabled} />
        Give loyalty levels
      </label>
      <div className="address-grid">
        <label>
          Silver from (₹ a year)
          <input name="silverSpend" type="number" min="1" step="1" required defaultValue={data.silver.spend / 100} />
        </label>
        <label>
          Silver: free delivery from (₹)
          <input
            name="silverFree"
            type="number"
            min="0"
            step="1"
            required
            defaultValue={data.silver.freeDeliveryMin / 100}
          />
        </label>
        <label>
          Silver: extra cashback (%)
          <input
            name="silverCashback"
            type="number"
            min="0"
            max="10"
            step="1"
            required
            defaultValue={data.silver.extraCashback}
          />
        </label>
        <label>
          Gold from (₹ a year)
          <input name="goldSpend" type="number" min="1" step="1" required defaultValue={data.gold.spend / 100} />
        </label>
        <label>
          Gold: free delivery from (₹)
          <input
            name="goldFree"
            type="number"
            min="0"
            step="1"
            required
            defaultValue={data.gold.freeDeliveryMin / 100}
          />
        </label>
        <label>
          Gold: extra cashback (%)
          <input
            name="goldCashback"
            type="number"
            min="0"
            max="10"
            step="1"
            required
            defaultValue={data.gold.extraCashback}
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
        Save loyalty levels
      </button>
    </form>
  );
}

// Refer a friend (stage 87): what a referred friend gets off their first order and what the referrer earns when it's
// kept. Off until switched on.
function Referrals() {
  const [version, setVersion] = useState(0);
  const { data } = useFetch('/admin/referrals', version);
  const [state, setState] = useState({ busy: false, error: null, done: null });
  if (!data) return null;
  const rupees = (v) => Math.round(Number(v) * 100);
  async function save(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null, done: null });
    try {
      await request('/admin/referrals', {
        method: 'PUT',
        body: {
          enabled: f.enabled === 'on',
          friendDiscount: rupees(f.friendDiscount),
          minOrder: rupees(f.minOrder),
          reward: rupees(f.reward),
          monthlyCap: Number(f.monthlyCap),
        },
      });
      setState({ busy: false, error: null, done: 'Saved.' });
      setVersion((v) => v + 1);
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
    }
  }
  return (
    <form key={JSON.stringify(data)} className="panel" onSubmit={save} aria-labelledby="referrals-heading">
      <h2 id="referrals-heading">Refer a friend</h2>
      <p className="muted small">
        Customers share a link from their account page. A friend who makes an account through it gets money off their
        first order (unless they use a coupon); the customer earns store credit once that order is kept past the return
        window. {data.joined} referred so far; {data.paid.rewards} rewards paid ({formatPrice(data.paid.total)}).
      </p>
      <label className="check">
        <input name="enabled" type="checkbox" defaultChecked={data.enabled} />
        Offer referrals
      </label>
      <div className="address-grid">
        <label>
          Friend&apos;s discount (₹)
          <input
            name="friendDiscount"
            type="number"
            min="1"
            step="1"
            required
            defaultValue={data.friendDiscount / 100}
          />
        </label>
        <label>
          On first orders from (₹)
          <input name="minOrder" type="number" min="0" step="1" required defaultValue={data.minOrder / 100} />
        </label>
        <label>
          Reward (₹ of store credit)
          <input name="reward" type="number" min="1" step="1" required defaultValue={data.reward / 100} />
        </label>
        <label>
          Rewards per customer a month
          <input name="monthlyCap" type="number" min="1" max="100" step="1" required defaultValue={data.monthlyCap} />
        </label>
      </div>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && <p role="status">{state.done}</p>}
      <button type="submit" className="btn primary" disabled={state.busy}>
        Save referrals
      </button>
    </form>
  );
}

export default function AdminCoupons() {
  const [version, setVersion] = useState(0);
  const { data: coupons, error } = useFetch('/admin/coupons', version);
  const [state, setState] = useState({ busy: false, error: null });
  const [type, setType] = useState('percent');

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

  async function create(e) {
    e.preventDefault();
    const form = e.currentTarget;
    if (await run(() => request('/admin/coupons', { method: 'POST', body: couponBody(form) }))) {
      form.reset();
      setType('percent');
    }
  }

  const setActive = (c, active) => run(() => request(`/admin/coupons/${c.id}`, { method: 'PATCH', body: { active } }));

  return (
    <div className="admin-form">
      <section className="panel">
        <div className="admin-head">
          <h1>Coupons</h1>
        </div>
        <p className="muted small">
          Each customer can use a coupon once; cancelling the order gives the use back. Coupons can be switched off but
          not deleted, because orders refer to them.
        </p>
        {(state.error || error) && (
          <p className="error" role="alert">
            {state.error ?? error.message}
          </p>
        )}
        {coupons?.length === 0 && <p className="muted">No coupons yet. Create one below.</p>}
        {coupons?.length > 0 && (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Discount</th>
                  <th>Conditions</th>
                  <th>Used</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {coupons.map((c) => (
                  <tr key={c.id} className={c.active ? '' : 'inactive'}>
                    <td>
                      <strong>{c.code}</strong>
                    </td>
                    <td>{describeCoupon(c)}</td>
                    <td>{conditions(c)}</td>
                    <td>
                      {c.usedCount}
                      {c.usageLimit ? ` / ${c.usageLimit}` : ''}
                    </td>
                    <td>
                      <div className="status-cell">
                        <span className={`status ${c.active ? 'placed' : 'cancelled'}`}>{c.active ? 'On' : 'Off'}</span>
                        <button
                          type="button"
                          className="link"
                          onClick={() => setActive(c, !c.active)}
                          disabled={state.busy}
                        >
                          {c.active ? 'Switch off' : 'Switch on'}
                          <span className="sr-only"> {c.code}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <form className="panel admin-form" onSubmit={create} aria-labelledby="new-coupon">
        <h2 id="new-coupon">New coupon</h2>
        <div className="address-grid">
          <label>
            Code
            <input name="code" required pattern="[A-Za-z0-9]{3,20}" title="3–20 letters and digits" maxLength={20} />
          </label>
          <label>
            Discount
            <select name="type" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="percent">Percentage off</option>
              <option value="flat">Amount off</option>
              <option value="free_delivery">Free delivery</option>
            </select>
          </label>
          {type === 'percent' && (
            <>
              <label>
                Percent off
                <input name="value" type="number" required min={1} max={90} step={1} />
              </label>
              <label>
                Maximum discount, ₹ (optional)
                <input name="maxDiscount" type="number" min={1} step={1} />
              </label>
            </>
          )}
          {type === 'flat' && (
            <label>
              Amount off, ₹
              <input name="value" type="number" required min={1} step={1} />
            </label>
          )}
          <label>
            Minimum order, ₹ (optional)
            <input name="minSubtotal" type="number" min={0} step="any" />
          </label>
          <label>
            Last day (optional)
            <input name="expiresAt" type="date" />
          </label>
          <label>
            Total uses (optional)
            <input name="usageLimit" type="number" min={1} step={1} />
          </label>
        </div>
        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={state.busy}>
            Create coupon
          </button>
        </div>
      </form>
      <Cashback />
      <Loyalty />
      <Referrals />
      <BirthdayTreat />
      <FreeGift />
    </div>
  );
}
