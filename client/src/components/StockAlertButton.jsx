import { useState } from 'react';
import { Link } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';

// For a sold-out product, or a sold-out `variant` of one: asks to be emailed (once) when it's back. Logged out, it
// leads to the login page. `onChange` lets the page reload the product's saved alerts.
export default function StockAlertButton({ product, variant = null, onChange }) {
  const { user } = useAuth();
  const [on, setOn] = useState(variant ? product.stockAlertVariants.includes(variant.id) : product.stockAlert);
  // "it" for the whole product, or the variant's label ("UK 10").
  const what = variant ? variant.label : 'it';
  const path = `/stock-alerts/${product.id}${variant ? `?variant=${variant.id}` : ''}`;
  const [state, setState] = useState({ busy: false, error: null });

  if (user === undefined) return null;
  if (!user) {
    return (
      <Link to={`/login?next=${encodeURIComponent(`/p/${product.slug}`)}`} className="btn primary">
        Log in to get an email when {what}'s back
      </Link>
    );
  }

  async function toggle() {
    setState({ busy: true, error: null });
    try {
      const res = await request(path, { method: on ? 'DELETE' : 'PUT' });
      setOn(res.stockAlert);
      setState({ busy: false, error: null });
      onChange?.();
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <div className="stock-alert">
      {on ? (
        <>
          <p role="status">
            We'll email {user.email} when {what}'s back in stock.
          </p>
          <button type="button" className="btn small" onClick={toggle} disabled={state.busy}>
            Cancel alert
          </button>
        </>
      ) : (
        <button type="button" className="btn primary" onClick={toggle} disabled={state.busy}>
          Email me when {what}'s back
        </button>
      )}
      {state.error && <p className="error small">{state.error}</p>}
    </div>
  );
}
