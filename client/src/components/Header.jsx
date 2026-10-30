import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { request } from '../api.js';
import { isStaff } from '../permissions.js';
import { useAuth } from '../auth.jsx';
import { cartCount, forgetCart, useCart } from '../cart.js';
import { useFetch } from '../useFetch.js';
import { BagIcon, CartIcon, ChevronDown, HeartIcon, UserIcon } from './Icons.jsx';
import SearchBox from './SearchBox.jsx';

// The logged-in customer's menu: their pages and logging out. A disclosure (a button showing a list of links), closed
// by Escape (focus back on the button), a click elsewhere or choosing an item.
function AccountMenu({ user }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const escape = (e) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      ref.current?.querySelector('button')?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  // A full page load afterwards, so no page is left showing what the account could see.
  async function logOut() {
    await request('/auth/logout', { method: 'POST' }).catch(() => {});
    forgetCart(); // it stays saved in the account
    window.location.assign('/');
  }

  const close = () => setOpen(false);
  return (
    <div className="account-menu" ref={ref}>
      <button
        type="button"
        className="header-link"
        aria-expanded={open}
        aria-controls="account-menu-list"
        onClick={() => setOpen(!open)}
      >
        <UserIcon />
        <span className="header-label">{user.name.split(' ')[0]}</span>
        <ChevronDown />
      </button>
      {open && (
        <ul id="account-menu-list" className="account-menu-list">
          <li className="account-menu-who">
            <strong>{user.name}</strong>
            <span className="muted small">{user.email}</span>
          </li>
          <li>
            <Link to="/orders" onClick={close}>
              My orders
            </Link>
          </li>
          <li>
            <Link to="/wishlist" onClick={close}>
              Wishlist
            </Link>
          </li>
          <li>
            <Link to="/account" onClick={close}>
              Account and addresses
            </Link>
          </li>
          <li>
            <Link to="/help" onClick={close}>
              Help
            </Link>
          </li>
          <li>
            <button type="button" onClick={logOut}>
              Log out
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

// Scrolls the bar (not the page) so the current category is in view on narrow screens.
const showInBar = (link) => {
  const bar = link?.parentElement;
  if (bar) bar.scrollLeft = link.offsetLeft - (bar.clientWidth - link.offsetWidth) / 2;
};

// Every category under the header, so shoppers can move between them from any page. Not on the home page (it has
// its own), in the admin panel or at checkout.
function CategoryBar() {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const { data: categories } = useFetch('/categories');
  if (pathname === '/' || pathname.startsWith('/admin') || pathname === '/checkout' || !categories) return null;
  const current = pathname === '/search' ? (params.get('category') ?? '') : null;
  return (
    <nav className="category-bar" aria-label="Shop by category">
      <div className="category-bar-inner">
        <Link
          to="/search"
          className={current === '' ? 'active' : undefined}
          aria-current={current === '' ? 'page' : undefined}
        >
          All products
        </Link>
        {categories.map((c) => (
          <Link
            key={c.id}
            to={`/search?category=${c.slug}`}
            className={current === c.slug ? 'active' : undefined}
            aria-current={current === c.slug ? 'page' : undefined}
            ref={current === c.slug ? showInBar : undefined}
          >
            {c.name}
          </Link>
        ))}
      </div>
    </nav>
  );
}

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
          <BagIcon size={26} />
          Bazaar
        </Link>
        {/* Remounted when the URL's query changes (back/forward, category links) so the box shows it. */}
        <SearchBox key={urlQuery} initial={urlQuery} />
        <nav className="header-nav" aria-label="Account">
          {/* Nothing until the session check finishes, so "Log in" doesn't flash for logged-in users. */}
          {isStaff(user) && (
            <Link to="/admin" className="header-link">
              Admin
            </Link>
          )}
          {user === null && (
            <Link to="/login" className="header-link">
              <UserIcon />
              <span className="header-label">Log in</span>
            </Link>
          )}
          {user && <AccountMenu user={user} />}
          {user && (
            <Link to="/wishlist" className="header-link" aria-label="Wishlist">
              <HeartIcon />
              <span className="header-label" aria-hidden="true">
                Wishlist
              </span>
            </Link>
          )}
          <Link to="/cart" className="header-link" aria-label={`Cart, ${count} ${count === 1 ? 'item' : 'items'}`}>
            <span className="cart-icon">
              <CartIcon />
              {count > 0 && (
                <span className="cart-badge" aria-hidden>
                  {count}
                </span>
              )}
            </span>
            <span className="header-label" aria-hidden="true">
              Cart
            </span>
          </Link>
        </nav>
      </div>
      <CategoryBar />
    </header>
  );
}
