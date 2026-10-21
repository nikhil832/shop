import { useState } from 'react';
import { Link, Navigate } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ORDER_STATUS, formatDate, formatPrice, orderNumber } from '../format.js';
import { useFetch } from '../useFetch.js';

export function StatusBadge({ status }) {
  return <span className={`status ${status}`}>{ORDER_STATUS[status] ?? status}</span>;
}

export default function Orders() {
  const { user, setUser } = useAuth();
  const [logout, setLogout] = useState('idle'); // idle | busy | done
  const { data: orders, error } = useFetch(user ? '/orders' : null);

  // Checked before `!user`, which would otherwise send a user who just logged out to the login page.
  if (logout === 'done') return <Navigate to="/" replace />;
  if (user === undefined) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to="/login?next=/orders" replace />;

  async function logOut() {
    setLogout('busy');
    await request('/auth/logout', { method: 'POST' }).catch(() => {});
    setLogout('done');
    setUser(null);
  }

  return (
    <div className="orders-page">
      <section className="panel account">
        <div>
          <h1>My orders</h1>
          <span className="muted small">
            {user.name} · {user.email}
          </span>
        </div>
        <button type="button" className="btn small" onClick={logOut} disabled={logout === 'busy'}>
          Log out
        </button>
      </section>

      {error && <p className="error">{error.message}</p>}
      {!orders && !error && <p className="muted">Loading…</p>}
      {orders?.length === 0 && (
        <div className="empty-state">
          <p>You haven't placed any orders yet.</p>
          <Link to="/search" className="btn primary">
            Start shopping
          </Link>
        </div>
      )}
      <ul className="order-list">
        {orders?.map((o) => (
          <li key={o.id}>
            <Link to={`/orders/${o.id}`} className="panel order-card">
              <div className="order-thumbs">
                {o.items
                  .slice(0, 3)
                  .map((i) => i.image && <img key={i.productId} src={i.image} alt="" width="56" height="56" />)}
              </div>
              <div className="order-card-body">
                <span className="order-number">Order #{orderNumber(o)}</span>
                <span className="muted small">
                  {formatDate(o.createdAt)} · {o.items.length} {o.items.length === 1 ? 'item' : 'items'}
                </span>
                <span className="card-title">{o.items.map((i) => i.title).join(', ')}</span>
              </div>
              <div className="order-card-side">
                <StatusBadge status={o.status} />
                <strong>{formatPrice(o.total)}</strong>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
