import { useState } from 'react';
import { formatDate, formatPrice, smallImage } from '../format.js';
import { Link, Navigate } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';
import { addToCart, useCart } from '../cart.js';
import AccountNav from '../components/AccountNav.jsx';
import PriceTag from '../components/PriceTag.jsx';
import { useFetch } from '../useFetch.js';

// A price alert (stage 142): "Email me when it's ₹X or less", below today's price. Shown as set, reached or not set,
// with a small form to set or change it.
function PriceAlert({ product }) {
  const [target, setTarget] = useState(product.target);
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState({ busy: false, error: null });
  async function save(targetPrice) {
    setState({ busy: true, error: null });
    try {
      setTarget((await request(`/wishlist/${product.id}/target`, { method: 'PUT', body: { targetPrice } })).target);
      setEditing(false);
      setState({ busy: false, error: null });
    } catch (err) {
      setState({ busy: false, error: err.message.replace(/^targetPrice: /, '') });
    }
  }
  function submit(e) {
    e.preventDefault();
    save(Math.round(Number(new FormData(e.currentTarget).get('target')) * 100));
  }
  if (editing) {
    return (
      <form className="price-alert-form" onSubmit={submit} aria-label={`Price alert for ${product.title}`}>
        <label>
          Email me at (₹) or less
          <input
            name="target"
            type="number"
            min="1"
            step="1"
            max={Math.max(1, Math.ceil(product.price / 100) - 1)}
            required
            defaultValue={target ? target.price / 100 : ''}
          />
        </label>
        <button type="submit" className="btn small" disabled={state.busy}>
          Save alert
        </button>
        <button type="button" className="link small" onClick={() => setEditing(false)}>
          Cancel
        </button>
        {state.error && (
          <p className="error small" role="alert">
            {state.error}
          </p>
        )}
      </form>
    );
  }
  return (
    <p className="price-alert small">
      {target
        ? target.reachedAt
          ? `Reached your price of ${formatPrice(target.price)} on ${formatDate(target.reachedAt)}. `
          : `We'll email you at ${formatPrice(target.price)} or less. `
        : null}
      <button type="button" className="link small" onClick={() => setEditing(true)} disabled={state.busy}>
        {target ? 'Change' : 'Set a price alert'}
        <span className="sr-only"> for {product.title}</span>
      </button>
      {target && (
        <>
          {' · '}
          <button type="button" className="link small" onClick={() => save(null)} disabled={state.busy}>
            Remove alert<span className="sr-only"> for {product.title}</span>
          </button>
        </>
      )}
    </p>
  );
}

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
      {/* The picture repeats the name's link next to it: a shortcut for the mouse, skipped by keyboards and screen readers. */}
      <Link to={`/p/${product.slug}`} className="wish-image" tabIndex={-1} aria-hidden="true">
        {product.image && <img src={smallImage(product.image)} alt="" width="88" height="88" />}
      </Link>
      <div className="wish-info">
        <span className="brand">{product.brand}</span>
        <Link to={`/p/${product.slug}`} className="card-title">
          {product.title}
        </Link>
        <PriceTag price={product.price} mrp={product.mrp} from={product.priceFrom} />
        {soldOut && <span className="stock out">Out of stock</span>}
        <PriceAlert product={product} />
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

// Sharing the wishlist by a link (stage 106): made on request, copied or sent with the phone's share sheet, and
// stopped at any time (the link then stops working; sharing again makes a new one).
function ShareWishlist({ name }) {
  const [version, setVersion] = useState(0);
  const { data } = useFetch('/wishlist/share', version);
  const [state, setState] = useState({ busy: false, error: null, copied: false });
  if (!data) return null;
  const url = data.share && `${window.location.origin}/w/${data.share.token}`;

  async function change(method) {
    setState({ busy: true, error: null, copied: false });
    try {
      await request('/wishlist/share', { method });
      setState({ busy: false, error: null, copied: false });
      setVersion((v) => v + 1);
    } catch (err) {
      setState({ busy: false, error: err.message, copied: false });
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setState({ ...state, copied: true });
    } catch {
      setState({ ...state, error: 'Copying is blocked here: select the link and copy it.' });
    }
  }

  return (
    <section className="panel share-wishlist" aria-labelledby="share-heading">
      <h2 id="share-heading">Share your wishlist</h2>
      {url ? (
        <>
          <p className="muted small">
            Anyone with this link sees your first name ({name}) and the products here, nothing else.
          </p>
          <div className="share-link">
            <input readOnly value={url} aria-label="Link to your wishlist" onFocus={(e) => e.target.select()} />
            <button type="button" className="btn small" onClick={copy}>
              {state.copied ? 'Copied' : 'Copy link'}
            </button>
            {navigator.share && (
              <button
                type="button"
                className="btn small"
                onClick={() => navigator.share({ title: `${name}'s wishlist`, url }).catch(() => {})}
              >
                Share…
              </button>
            )}
            <button type="button" className="btn small" onClick={() => change('DELETE')} disabled={state.busy}>
              Stop sharing
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted small">
            Send a link to family and friends for birthdays and festivals. They&apos;ll see your first name and the
            products here, and can buy one as a gift.
          </p>
          <button type="button" className="btn primary" onClick={() => change('POST')} disabled={state.busy}>
            Share my wishlist
          </button>
        </>
      )}
      {state.error && <p className="error small">{state.error}</p>}
    </section>
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
      {items?.length > 0 && <ShareWishlist name={user.name.split(/\s+/)[0]} />}
      <ul className="order-list">
        {items?.map((p) => (
          <WishRow key={p.id} product={p} onRemoved={() => setVersion((v) => v + 1)} />
        ))}
      </ul>
    </div>
  );
}
