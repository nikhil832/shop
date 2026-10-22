import { NavLink } from 'react-router';

// Tabs between the customer's own pages.
export default function AccountNav() {
  return (
    <nav className="admin-tabs" aria-label="My account">
      <NavLink to="/orders" end>
        My orders
      </NavLink>
      <NavLink to="/wishlist">Wishlist</NavLink>
      <NavLink to="/account">Account</NavLink>
    </nav>
  );
}
