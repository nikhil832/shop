import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../auth.jsx';
import { cartCount, useCart } from '../cart.js';

export default function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const { user } = useAuth();
  const count = cartCount(useCart());
  const urlQuery = location.pathname === '/search' ? (params.get('q') ?? '') : '';

  function submit(e) {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get('q').trim();
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
  }

  return (
    <header className="header">
      <div className="header-inner">
        <Link to="/" className="logo">
          Bazaar
        </Link>
        {/* Remounted when the URL's query changes (back/forward, category links) so the box shows it. */}
        <form key={urlQuery} className="search-form" role="search" onSubmit={submit}>
          <input
            name="q"
            type="search"
            placeholder="Search for products and brands"
            aria-label="Search products"
            defaultValue={urlQuery}
          />
          <button type="submit" aria-label="Search">
            🔍
          </button>
        </form>
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
