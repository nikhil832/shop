import { useState } from 'react';
import { request } from '../api.js';
import { itemKey } from '../cart.js';
import { formatDate, formatPrice } from '../format.js';

// How a cancellation's money came back, in words.
function moneyText(c, admin) {
  const parts = [];
  if (c.refund) {
    const status = {
      pending: 'refund to start',
      refunding: 'refund starting',
      refunded: 'refund started',
      refund_failed: admin ? 'refund failed' : 'refund on its way',
    }[c.refundStatus];
    parts.push(`${formatPrice(c.refund)} ${status}`);
  }
  if (c.creditBack) parts.push(`${formatPrice(c.creditBack)} back to store credit`);
  return parts.join(' · ');
}

// Items cancelled before shipping (stage 97): one row per cancellation. Admins see who did it, why a refund failed,
// and can retry it (`retry(c)`).
export function CancelledItems({ order, admin = false, retry, busy }) {
  if (!order.cancellations?.length) return null;
  return (
    <div className="cancelled-items">
      <h3>Cancelled before shipping</h3>
      <ul>
        {order.cancellations.map((c) => (
          <li key={c.id}>
            <span>{c.items.map((i) => `${i.title} × ${i.qty}`).join(', ')}</span>
            <span className="muted small block">
              {formatDate(c.at)} ·{' '}
              {c.role === 'admin' ? `by ${admin && c.by ? c.by : 'the store'}` : admin ? 'by the customer' : 'by you'} ·{' '}
              {formatPrice(c.amount)} off the total
              {moneyText(c, admin) && ` · ${moneyText(c, admin)}`}
            </span>
            {admin && c.refundStatus === 'refund_failed' && (
              <>
                {c.refundError && <span className="error small block">{c.refundError}</span>}
                <button type="button" className="btn small" onClick={() => retry(c)} disabled={busy}>
                  Retry refund
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// "Cancel some items" on an order that hasn't shipped: how many of each line to cancel, then a check of what that
// changes (the server's preview) before anything is cancelled. `path` is the order's cancel-items address;
// `onDone(order)` shows the changed order. Only offered while more than one unit is left (the last one is the whole
// order's cancel).
export default function CancelItems({ order, path, onDone }) {
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState({});
  const [state, setState] = useState({ busy: false, error: null, preview: null });
  const units = order.items.reduce((n, i) => n + i.qty, 0);
  if (units < 2) return null;
  if (!open) {
    return (
      <button type="button" className="btn small" onClick={() => setOpen(true)}>
        Cancel some items
      </button>
    );
  }
  const chosen = order.items
    .map((line, index) => ({ index, qty: Number(counts[index] ?? 0) }))
    .filter((i) => i.qty > 0);
  const change = (index, value) => {
    setCounts({ ...counts, [index]: value });
    setState({ busy: false, error: null, preview: null }); // a new choice needs a new check
  };
  const close = () => {
    setOpen(false);
    setCounts({});
    setState({ busy: false, error: null, preview: null });
  };
  async function send(preview) {
    setState({ ...state, busy: true, error: null });
    try {
      const result = await request(path, { method: 'POST', body: { items: chosen, preview } });
      if (preview) {
        setState({ busy: false, error: null, preview: result.preview });
      } else {
        onDone(result);
        close();
      }
    } catch (err) {
      setState({ busy: false, error: err.message, preview: null });
    }
  }
  const p = state.preview;
  return (
    <form
      className="cancel-items"
      aria-label="Cancel some items"
      onSubmit={(e) => {
        e.preventDefault();
        send(!p);
      }}
    >
      <p className="muted small">Choose how many of each to cancel. At least one item must stay in the order.</p>
      {order.items.map((line, index) => (
        <label key={itemKey(line)}>
          <span>
            {line.title} <span className="muted">({line.qty} in the order)</span>
          </span>
          <select value={counts[index] ?? 0} onChange={(e) => change(index, e.target.value)}>
            {Array.from({ length: line.qty + 1 }, (_, n) => (
              <option key={n} value={n}>
                {n === 0 ? 'Keep' : `Cancel ${n}`}
              </option>
            ))}
          </select>
        </label>
      ))}
      {p && (
        <div className="notice" role="status">
          <p>
            The total becomes <strong>{formatPrice(p.total)}</strong> ({formatPrice(p.amount)} less).
            {p.refund > 0 && ` ${formatPrice(p.refund)} is refunded to the way it was paid.`}
            {p.creditBack > 0 && ` ${formatPrice(p.creditBack)} goes back to store credit.`}
            {p.toCollect !== null && p.toCollect > 0 && ` ${formatPrice(p.toCollect)} is paid on delivery.`}
          </p>
        </div>
      )}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={state.busy || !chosen.length}>
          {p ? 'Cancel these items' : 'Check the new total'}
        </button>
        <button type="button" className="btn" onClick={close}>
          Don't cancel anything
        </button>
      </div>
    </form>
  );
}
