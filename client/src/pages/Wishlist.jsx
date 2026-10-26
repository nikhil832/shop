import { useState } from 'react';
import { Link, Navigate } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';
import { addToCart, useCart } from '../cart.js';
import AccountNav from '../components/AccountNav.jsx';
import PriceTag from '../components/PriceTag.jsx';
import { useFetch } from '../useFetch.js';

function WishRow({ product, onRemoved }) {
  const items = useCart();
  const [state, setState] = useState({ busy: false, error: null });
  const inCart = items.find((i) => i.productId === product.id)?.qty ?? 0;
  const soldOut = product.stock === 0;

  async function remove() {
    setState({ busy: true, error: null });
    try {
      await request(`/wishlist/${product.id}`, { method: 'DELETE' });
      onRemoved();
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <li className="panel wish-row">
      <Link to={`/p/${product.slug}`} className="wish-image">
        {product.image && <img src={product.image} alt="" width="88" height="88" />}
      </Link>
      <div className="wish-info">
        <span className="brand">{product.brand}</span>
        <Link to={`/p/${product.slug}`} className="card-title">
          {product.title}
        </Link>
        <PriceTag price={product.price} mrp={product.mrp} from={product.priceFrom} />
        {soldOut && <span className="stock out">Out of stock</span>}
        {state.error && <p className="error small">{state.error}</p>}
      </div>
      <div className="wish-actions">
        {/* A product with sizes is added from its page, where the size is chosen. */}
        {!soldOut && product.variantName && (
          <Link to={`/p/${product.slug}`} className="btn primary small">
            Choose {product.variantName.toLowerCase()}
            <span className="sr-only"> for {product.title}</span>
          </Link>
        )}
        {!soldOut &&
          !product.variantName &&
          (inCart ? (
            <Link to="/cart" className="btn small">
              In cart ({inCart})
            </Link>
          ) : (
            <button
              type="button"
              className="btn primary small"
              onClick={() =>
                addToCart(product.id, product.stock) ||
                setState({ busy: false, error: 'Your cart is full. Remove something to add this.' })
              }
            >
              Add to cart
              <span className="sr-only"> {product.title}</span>
            </button>
          ))}
        <button type="button" className="link" onClick={remove} disabled={state.busy}>
          Remove
          <span className="sr-only"> {product.title}</span>
        </button>
      </div>
    </li>
  );
}

export default function Wishlist() {
  const { user } = useAuth();
  const [version, setVersion] = useState(0);
  const { data: items, error } = useFetch(user ? '/wishlist' : null, version);

  if (user === undefined) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to="/login?next=/wishlist" replace />;

  return (
    <div className="orders-page">
      <AccountNav />
      <h1>
        Wishlist{' '}
        {items?.length > 0 && (
          <span className="muted small">
            ({items.length} {items.length === 1 ? 'item' : 'items'})
          </span>
        )}
      </h1>
      {items?.length > 0 && (
        <p className="muted small">
          {user.priceDropEmails
            ? "We'll email you when anything here gets 5% cheaper or more. "
            : 'Price-drop emails are off. '}
          <Link to="/account">{user.priceDropEmails ? 'Change this' : 'Turn them on'}</Link> on your account page.
        </p>
      )}
      {error && <p className="error">{error.message}</p>}
      {!items && !error && <p className="muted">Loading…</p>}
      {items?.length === 0 && (
        <div className="empty-state">
          <p>Your wishlist is empty. Tap “Save to wishlist” on any product to keep it here.</p>
          <Link to="/search" className="btn primary">
            Start shopping
          </Link>
        </div>
      )}
      <ul className="order-list">
        {items?.map((p) => (
          <WishRow key={p.id} product={p} onRemoved={() => setVersion((v) => v + 1)} />
        ))}
      </ul>
    </div>
  );
}
