import { Component, Suspense } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import Header from './Header.jsx';
import AssistantButton from './AssistantButton.jsx';
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

export default function Layout() {
  const { pathname } = useLocation();
  return (
    <>
      <Header />
      <main className="page">
        {/* Pages loaded on first use (main.jsx) show "Loading…" meanwhile; a new page gets a fresh error boundary. */}
        <PageError key={pathname}>
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <Outlet />
          </Suspense>
        </PageError>
      </main>
      <footer className="footer">
        Bazaar · a demo store · prices in ₹ · <Link to="/help">Contact us</Link>
      </footer>
      <AssistantButton />
    </>
  );
}
