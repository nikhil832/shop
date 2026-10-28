import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { request } from '../../api.js';
import {
  HELP_STATUS,
  HELP_TOPICS,
  addressLine,
  formatDate,
  formatPrice,
  orderNumber,
  refundText,
} from '../../format.js';
import { useFetch } from '../../useFetch.js';
import NotFound from '../NotFound.jsx';
import { StatusBadge } from '../Orders.jsx';
import { CreditBox } from './AdminHelp.jsx';
import CustomerTags, { CUSTOMER_TAGS } from '../../components/CustomerTags.jsx';

const ROLES = { user: 'Customer', admin: 'Admin', packer: 'Packer', support: 'Support' };
const CREDIT_REASONS = {
  goodwill: 'Added by the store',
  taken: 'Taken back by the store',
  returned: 'Return refunded as credit',
  cancelled: 'Back from a cancelled order',
  spent: 'Paid for an order',
  gift_card: 'Gift card redeemed',
};

// Tags (stage 82): ticked boxes, saved as soon as one changes.
function TagEditor({ customer, onSaved }) {
  const [state, setState] = useState({ busy: false, error: null });
  async function toggle(tag, on) {
    const tags = on ? [...customer.tags, tag] : customer.tags.filter((t) => t !== tag);
    setState({ busy: true, error: null });
    try {
      await request(`/admin/customers/${customer.id}/tags`, { method: 'PUT', body: { tags } });
      setState({ busy: false, error: null });
      onSaved();
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }
  return (
    <fieldset className="customer-tag-editor">
      <legend>Tags</legend>
      {Object.entries(CUSTOMER_TAGS).map(([tag, label]) => (
        <label key={tag} className="check">
          <input
            type="checkbox"
            checked={customer.tags.includes(tag)}
            disabled={state.busy}
            onChange={(e) => toggle(tag, e.target.checked)}
          />
          {label}
        </label>
      ))}
      {state.error && <p className="error small">{state.error}</p>}
    </fieldset>
  );
}

// Notes about the customer (stage 82): shown on their orders too. They're in the customer's own data download.
function Notes({ customer, onChange }) {
  const [state, setState] = useState({ busy: false, error: null });
  const [formKey, setFormKey] = useState(0);
  async function run(action) {
    setState({ busy: true, error: null });
    try {
      await action();
      setState({ busy: false, error: null });
      onChange();
      return true;
    } catch (err) {
      setState({ busy: false, error: err.message });
      return false;
    }
  }
  return (
    <section className="panel" aria-labelledby="customer-notes">
      <h2 id="customer-notes">Notes</h2>
      {customer.notes.length > 0 && (
        <ul className="plain-list">
          {customer.notes.map((n) => (
            <li key={n.id}>
              {n.text}
              <span className="muted small block">
                {n.by ?? 'Admin'} · {formatDate(n.at)} ·{' '}
                <button
                  type="button"
                  className="link danger"
                  disabled={state.busy}
                  onClick={() =>
                    run(() => request(`/admin/customers/${customer.id}/notes/${n.id}`, { method: 'DELETE' }))
                  }
                >
                  Remove<span className="sr-only"> the note “{n.text}”</span>
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        key={formKey}
        className="review-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const text = new FormData(e.currentTarget).get('text');
          const done = await run(() =>
            request(`/admin/customers/${customer.id}/notes`, { method: 'POST', body: { text } }),
          );
          if (done) setFormKey((k) => k + 1);
        }}
      >
        <label>
          Add a note
          <textarea name="text" rows={2} minLength={2} maxLength={500} required />
        </label>
        <p className="muted small">
          Seen by admins and staff on this customer&apos;s orders. The customer sees notes too if they download their
          data, so keep them factual.
        </p>
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        <button type="submit" className="btn small" disabled={state.busy}>
          Add note
        </button>
      </form>
    </section>
  );
}

// One account on Admin → Customers (stage 74): details, totals, the latest orders, returns and help requests, and store
// credit with its history and the form to give some.
export default function AdminCustomer() {
  const { id } = useParams();
  const [version, setVersion] = useState(0);
  const { data, error } = useFetch(`/admin/customers/${id}`, version);

  if (error?.status === 404 || error?.status === 400) return <NotFound message="We couldn't find that customer." />;
  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const { customer: c, totals, orders, returns, help, credit } = data;

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/admin/customers">Customers</Link>
        <span aria-hidden>›</span>
        <span>{c.name}</span>
      </nav>

      <section className="panel">
        <div className="admin-head">
          <h1>
            {c.name}
            <CustomerTags tags={c.tags} />
          </h1>
          <span className="muted">{ROLES[c.role] ?? c.role}</span>
        </div>
        <p>
          {c.email}
          <span className="muted small block">
            Joined {formatDate(c.createdAt)} · two-step login {c.twoStep ? 'on' : 'off'} · price-drop emails{' '}
            {c.emails.priceDrops ? 'on' : 'off'} · cart reminders {c.emails.cartReminders ? 'on' : 'off'}
          </span>
        </p>
        <dl className="customer-totals">
          <div>
            <dt>Spent</dt>
            <dd>{formatPrice(totals.spent)}</dd>
          </div>
          <div>
            <dt>Orders</dt>
            <dd>
              {totals.orders}
              {totals.allOrders > totals.orders && (
                <span className="muted small"> (+{totals.allOrders - totals.orders} unpaid or cancelled)</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Refunded</dt>
            <dd>{formatPrice(totals.refunded)}</dd>
          </div>
          <div>
            <dt>Store credit</dt>
            <dd>{formatPrice(c.credit)}</dd>
          </div>
          <div>
            <dt>Reviews · questions · wishlist</dt>
            <dd>
              {totals.reviews} · {totals.questions} · {totals.wishlist}
            </dd>
          </div>
        </dl>
        {c.addresses.length > 0 && (
          <>
            <h2>Addresses</h2>
            <ul className="plain-list small">
              {c.addresses.map((a, i) => (
                <li key={a.id}>
                  {addressLine(a)}
                  {i === 0 && <span className="muted"> (default)</span>}
                </li>
              ))}
            </ul>
          </>
        )}
        <TagEditor customer={c} onSaved={() => setVersion((v) => v + 1)} />
      </section>

      <Notes customer={c} onChange={() => setVersion((v) => v + 1)} />

      {(data.cod.refused > 0 || !data.cod.allowed) && (
        <section className="panel" aria-labelledby="customer-cod">
          <h2 id="customer-cod">Cash on Delivery</h2>
          <p>
            {data.cod.refused} Cash on Delivery {data.cod.refused === 1 ? 'order' : 'orders'} came back refused or
            unreachable. {data.cod.allowed ? 'They can still pay on delivery.' : 'They must pay online.'}
          </p>
          {!data.cod.allowed && (
            <button
              type="button"
              className="btn small"
              onClick={async () => {
                await request(`/admin/cod/forgive/${c.id}`, { method: 'POST' });
                setVersion((v) => v + 1);
              }}
            >
              Allow Cash on Delivery again
            </button>
          )}
        </section>
      )}

      <section className="panel" aria-labelledby="customer-orders">
        <h2 id="customer-orders">Orders</h2>
        {orders.length === 0 ? (
          <p className="muted">No orders yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Date</th>
                  <th className="num">Items</th>
                  <th className="num">Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link to={`/admin/orders/${o.id}`}>#{orderNumber(o)}</Link>
                    </td>
                    <td>{formatDate(o.createdAt)}</td>
                    <td className="num">{o.items}</td>
                    <td className="num">
                      {formatPrice(o.total)}
                      {o.creditUsed > 0 && (
                        <span className="muted small block">{formatPrice(o.creditUsed)} store credit</span>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={o.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {totals.allOrders > orders.length && (
          <p className="small">
            <Link to={`/admin/orders?q=${encodeURIComponent(c.email)}`}>All {totals.allOrders} orders</Link>
          </p>
        )}
      </section>

      {returns.length > 0 && (
        <section className="panel" aria-labelledby="customer-returns">
          <h2 id="customer-returns">Returns</h2>
          <ul className="plain-list">
            {returns.map((r) => (
              <li key={r.id}>
                <Link to={`/admin/orders/${r.orderId}`}>
                  Order #{r.orderNumber ?? r.orderId.slice(-8).toUpperCase()}
                </Link>{' '}
                · {formatDate(r.createdAt)} · {r.reasonText} · {refundText(r)} · <StatusBadge status={r.status} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {help.length > 0 && (
        <section className="panel" aria-labelledby="customer-help">
          <h2 id="customer-help">Help requests</h2>
          <ul className="plain-list">
            {help.map((h) => (
              <li key={h.id}>
                <Link to={`/admin/help?status=${h.status}`}>Request #{h.number}</Link> · {HELP_TOPICS[h.topic]} ·{' '}
                {HELP_STATUS[h.status]} · {h.messages} {h.messages === 1 ? 'message' : 'messages'} · last{' '}
                {formatDate(h.updatedAt)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel" aria-labelledby="customer-credit">
        <h2 id="customer-credit">Store credit</h2>
        {credit.length > 0 && (
          <ul className="credit-history">
            {credit.map((e) => (
              <li key={e.id}>
                <span>
                  {CREDIT_REASONS[e.reason] ?? e.reason}
                  {e.order && (
                    <>
                      {' · '}
                      <Link to={`/admin/orders/${e.order.id}`}>Order #{orderNumber(e.order)}</Link>
                    </>
                  )}
                  {e.note && <span className="muted small block">{e.note}</span>}
                  <span className="muted small block">{formatDate(e.at)}</span>
                </span>
                <span className="num">
                  {e.change > 0 ? '+' : '−'}
                  {formatPrice(Math.abs(e.change))}
                </span>
              </li>
            ))}
          </ul>
        )}
        <CreditBox path={`/admin/customers/${c.id}/credit`} name={c.name} onChange={() => setVersion((v) => v + 1)} />
      </section>
    </>
  );
}
