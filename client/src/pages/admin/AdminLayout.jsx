import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '../../auth.jsx';

// Wraps every /admin page. The server checks the role on each request too; this only decides what to show.
export default function AdminLayout() {
  const { user } = useAuth();
  const location = useLocation();

  if (user === undefined) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (user.role !== 'admin') {
    return (
      <div className="empty-state">
        <h1>Admins only</h1>
        <p>This area is for store admins.</p>
      </div>
    );
  }

  return (
    <div className="admin">
      <nav className="admin-tabs" aria-label="Admin">
        <NavLink to="/admin" end>
          Dashboard
        </NavLink>
        <NavLink to="/admin/orders">Orders</NavLink>
        <NavLink to="/admin/products">Products</NavLink>
        <NavLink to="/admin/categories">Categories</NavLink>
        <NavLink to="/admin/reviews">Reviews</NavLink>
        <NavLink to="/admin/questions">Questions</NavLink>
        <NavLink to="/admin/help">Help</NavLink>
        <NavLink to="/admin/returns">Returns</NavLink>
        <NavLink to="/admin/coupons">Coupons</NavLink>
        <NavLink to="/admin/delivery">Delivery</NavLink>
        <NavLink to="/admin/gst">GST</NavLink>
        <NavLink to="/admin/activity">Activity</NavLink>
        <NavLink to="/admin/errors">Errors</NavLink>
      </nav>
      {!user.twoStep && (
        // Not on printed invoices and packing slips.
        <p className="notice no-print" role="note">
          This account can refund money and see every customer&rsquo;s address. Protect it with{' '}
          <Link to="/account#two-step">two-step login</Link>.
        </p>
      )}
      <Outlet />
    </div>
  );
}
