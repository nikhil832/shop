import { useState } from 'react';
import { Link } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';

// For a sold-out product: asks to be emailed (once) when it's back. Logged out, it leads to the login page.
export default function StockAlertButton({ product }) {
  const { user } = useAuth();
  const [on, setOn] = useState(product.stockAlert);
  const [state, setState] = useState({ busy: false, error: null });

  if (user === undefined) return null;
  if (!user) {
    return (
      <Link to={`/login?next=${encodeURIComponent(`/p/${product.slug}`)}`} className="btn primary">
        Log in to get an email when it's back
      </Link>
    );
  }

  async function toggle() {
    setState({ busy: true, error: null });
    try {
      const res = await request(`/stock-alerts/${product.id}`, { method: on ? 'DELETE' : 'PUT' });
      setOn(res.stockAlert);
      setState({ busy: false, error: null });
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <div className="stock-alert">
      {on ? (
        <>
          <p role="status">We'll email {user.email} when it's back in stock.</p>
          <button type="button" className="btn small" onClick={toggle} disabled={state.busy}>
            Cancel alert
          </button>
        </>
      ) : (
        <button type="button" className="btn primary" onClick={toggle} disabled={state.busy}>
          Email me when it's back
        </button>
      )}
      {state.error && <p className="error small">{state.error}</p>}
    </div>
  );
}
