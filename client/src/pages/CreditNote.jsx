import { Link, Navigate, useLocation, useParams } from 'react-router';
import { useAuth } from '../auth.jsx';
import { GstLines, GstParties } from '../components/GstDocument.jsx';
import { formatAmount, formatDate, orderNumber, returnStatusLabel } from '../format.js';
import { useFetch } from '../useFetch.js';
import NotFound from './NotFound.jsx';

// The GST credit note of an approved return (orders placed with GST on), for its customer
// (/orders/:id/credit-notes/:returnId) or an admin (/admin/orders/:id/credit-notes/:returnId). Printable like the
// invoice it reduces.
export default function CreditNote({ admin = false }) {
  const { id, returnId } = useParams();
  const { user } = useAuth();
  const location = useLocation();
  const orderPath = `${admin ? '/admin' : ''}/orders/${encodeURIComponent(id)}`;
  const { data: note, error } = useFetch(
    admin || user ? `${orderPath}/credit-notes/${encodeURIComponent(returnId)}` : null,
  );

  if (!admin && user === undefined) return <p className="muted">Loading…</p>;
  if (!admin && !user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (error?.status === 404 || error?.status === 400) return <NotFound message="We couldn't find that credit note." />;
  if (error) return <p className="error">{error.message}</p>;
  if (!note) return <p className="muted">Loading…</p>;

  const { order } = note;
  const ret = note.return;

  return (
    <div className="invoice-page">
      <div className="invoice-actions no-print">
        <Link to={orderPath}>← Back to order #{orderNumber(order)}</Link>
        <button type="button" className="btn primary" onClick={() => window.print()}>
          Print or save as PDF
        </button>
      </div>

      <article className="panel invoice" aria-labelledby="credit-note-heading">
        <header className="invoice-head">
          <div>
            <p className="invoice-brand">Bazaar</p>
            <p className="muted small">A demo store: nothing here is really sold or delivered.</p>
          </div>
          <div className="invoice-meta">
            <h1 id="credit-note-heading">Credit note</h1>
            <dl>
              <dt>Credit note no.</dt>
              <dd>{note.number}</dd>
              <dt>Date</dt>
              <dd>{formatDate(note.date)}</dd>
              <dt>Against invoice</dt>
              <dd>
                #{orderNumber(order)} of {formatDate(order.createdAt)}
              </dd>
            </dl>
          </div>
        </header>

        <GstParties doc={note} address={order.address} email={note.email} to="Issued to" />

        <p>
          <strong>Goods returned:</strong> {ret.reasonText}
        </p>
        <GstLines doc={note} total={note.totals.value} totalLabel="Total credit" />

        <p>
          <strong>Refund:</strong> {returnStatusLabel(ret, { admin })}
        </p>
        <p className="muted small">
          Amounts include GST of {formatAmount(note.totals.tax)}. Delivery charges are not refunded.
        </p>
      </article>
    </div>
  );
}
