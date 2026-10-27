import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '../../auth.jsx';
import { can, isStaff } from '../../permissions.js';

// The admin panel's tabs and what each needs (admins have everything); staff see only theirs.
export const ADMIN_TABS = [
  { to: '/admin', label: 'Dashboard', permission: '*' },
  { to: '/admin/orders', label: 'Orders', permission: 'orders.view' },
  { to: '/admin/products', label: 'Products', permission: '*' },
  { to: '/admin/categories', label: 'Categories', permission: '*' },
  { to: '/admin/reviews', label: 'Reviews', permission: 'reviews' },
  { to: '/admin/questions', label: 'Questions', permission: 'questions' },
  { to: '/admin/help', label: 'Help', permission: 'help' },
  { to: '/admin/returns', label: 'Returns', permission: '*' },
  { to: '/admin/coupons', label: 'Coupons', permission: '*' },
  { to: '/admin/delivery', label: 'Delivery', permission: '*' },
  { to: '/admin/gst', label: 'GST', permission: '*' },
  { to: '/admin/activity', label: 'Activity', permission: '*' },
  { to: '/admin/errors', label: 'Errors', permission: '*' },
  { to: '/admin/staff', label: 'Staff', permission: '*' },
];

// Wraps every /admin page. The server checks the role on each request too; this only decides what to show.
export default function AdminLayout() {
  const { user } = useAuth();
  const location = useLocation();

  if (user === undefined) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (!isStaff(user)) {
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
        {ADMIN_TABS.filter((tab) => can(user, tab.permission)).map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.to === '/admin'}>
            {tab.label}
          </NavLink>
        ))}
      </nav>
      {!user.twoStep && (
        // Not on printed invoices and packing slips.
        <p className="notice no-print" role="note">
          {user.role === 'admin'
            ? 'This account can refund money and see every customer’s address.'
            : 'This account can see customers’ orders and addresses.'}{' '}
          Protect it with <Link to="/account#two-step">two-step login</Link>.
        </p>
      )}
      <Outlet />
    </div>
  );
}
