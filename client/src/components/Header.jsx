import { Link, useLocation, useSearchParams } from 'react-router';
import { useAuth } from '../auth.jsx';
import { cartCount, useCart } from '../cart.js';
import SearchBox from './SearchBox.jsx';

export default function Header() {
  const location = useLocation();
  const [params] = useSearchParams();
  const { user } = useAuth();
  const count = cartCount(useCart());
  const urlQuery = location.pathname === '/search' ? (params.get('q') ?? '') : '';

  return (
    <header className="header">
      <div className="header-inner">
        <Link to="/" className="logo">
          Bazaar
        </Link>
        {/* Remounted when the URL's query changes (back/forward, category links) so the box shows it. */}
        <SearchBox key={urlQuery} initial={urlQuery} />
        <nav className="header-nav" aria-label="Account">
          {/* Nothing until the session check finishes, so "Log in" doesn't flash for logged-in users. */}
          {user?.role === 'admin' && (
            <Link to="/admin" className="header-link">
              Admin
            </Link>
          )}
          {user !== undefined && (
            <Link to={user ? '/orders' : '/login'} className="header-link">
              {user ? user.name.split(' ')[0] : 'Log in'}
            </Link>
          )}
          <Link to="/cart" className="header-link" aria-label={`Cart, ${count} ${count === 1 ? 'item' : 'items'}`}>
            🛒 Cart
            {count > 0 && (
              <span className="cart-badge" aria-hidden>
                {count}
              </span>
            )}
          </Link>
        </nav>
      </div>
    </header>
  );
}
