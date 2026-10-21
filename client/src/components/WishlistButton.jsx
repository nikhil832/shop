import { useState } from 'react';
import { Link } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';

// Saves the product to (or removes it from) the account's wishlist. Logged out, it leads to the login page.
export default function WishlistButton({ product }) {
  const { user } = useAuth();
  const [saved, setSaved] = useState(product.wishlisted);
  const [state, setState] = useState({ busy: false, error: null });

  if (user === undefined) return null;
  if (!user) {
    return (
      <Link to={`/login?next=${encodeURIComponent(`/p/${product.slug}`)}`} className="btn wish-btn">
        ♡ Save to wishlist
      </Link>
    );
  }

  async function toggle() {
    setState({ busy: true, error: null });
    try {
      const res = await request(`/wishlist/${product.id}`, { method: saved ? 'DELETE' : 'PUT' });
      setSaved(res.saved);
      setState({ busy: false, error: null });
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <div className="wish">
      <button
        type="button"
        className={`btn wish-btn ${saved ? 'saved' : ''}`}
        aria-pressed={saved}
        onClick={toggle}
        disabled={state.busy}
      >
        {saved ? '♥ Saved to wishlist' : '♡ Save to wishlist'}
      </button>
      {saved && <Link to="/wishlist">View wishlist</Link>}
      {state.error && <p className="error small">{state.error}</p>}
    </div>
  );
}
