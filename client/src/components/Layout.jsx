import { Component, Suspense } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import Header from './Header.jsx';
import AssistantButton from './AssistantButton.jsx';
import AnnouncementBar from './AnnouncementBar.jsx';
import CompareTray from './CompareTray.jsx';
import { formatPrice } from '../format.js';
import { FREE_DELIVERY_MIN, RETURN_DAYS } from '../storeFacts.js';
import { BagIcon } from './Icons.jsx';
import { reportError } from '../errorReports.js';

// A page that failed to load or crashed shows this instead of a blank screen, and is reported to the admins; going
// to another page tries again.
class PageError extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error, info) {
    reportError(error?.pageLoad ? 'load' : 'crash', error, info.componentStack);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty-state" role="alert">
        <h1>This page didn&apos;t load</h1>
        <p>Check your connection and try again. If the store was just updated, reloading gets the new version.</p>
        <button type="button" className="btn primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

// Links to the store's main pages, help and the customer's own pages, with the store's promises at the bottom.
// Link names differ from the account pages' tabs ("Your orders", not "My orders"), so tests finding those stay exact.
function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <Link to="/" className="footer-logo">
            <BagIcon size={22} />
            Bazaar
          </Link>
          <p>
            Mobiles, laptops, fashion, home essentials and books, delivered to your door. Pay online or when it arrives.
          </p>
        </div>
        <nav aria-labelledby="footer-shop">
          <h2 id="footer-shop">Shop</h2>
          <ul>
            <li>
              <Link to="/search">All products</Link>
            </li>
            <li>
              <Link to="/search?deals=1&sort=discount">Deals</Link>
            </li>
            <li>
              <Link to="/search?sort=newest">New arrivals</Link>
            </li>
            <li>
              <Link to="/search?sort=rating">Highest rated</Link>
            </li>
            <li>
              <Link to="/gift-cards">Gift cards</Link>
            </li>
          </ul>
        </nav>
        <nav aria-labelledby="footer-help">
          <h2 id="footer-help">Help</h2>
          <ul>
            <li>
              <Link to="/help">Contact us</Link>
            </li>
            <li>
              <Link to="/orders">Track an order</Link>
            </li>
            <li>
              <Link to="/orders">Returns and exchanges</Link>
            </li>
          </ul>
        </nav>
        <nav aria-labelledby="footer-you">
          <h2 id="footer-you">Your account</h2>
          <ul>
            <li>
              <Link to="/orders">Your orders</Link>
            </li>
            <li>
              <Link to="/wishlist">Your wishlist</Link>
            </li>
            <li>
              <Link to="/compare">Compare products</Link>
            </li>
          </ul>
        </nav>
      </div>
      <p className="footer-bottom">
        Bazaar · a demo store · prices in ₹ inclusive of taxes · free delivery over {formatPrice(FREE_DELIVERY_MIN)} ·{' '}
        {RETURN_DAYS}-day returns
      </p>
    </footer>
  );
}

export default function Layout() {
  const { pathname } = useLocation();
  return (
    <>
      <AnnouncementBar />
      <Header />
      <main className="page">
        {/* Pages loaded on first use (main.jsx) show "Loading…" meanwhile; a new page gets a fresh error boundary. */}
        <PageError key={pathname}>
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <Outlet />
          </Suspense>
        </PageError>
      </main>
      <Footer />
      <CompareTray />
      <AssistantButton />
    </>
  );
}
