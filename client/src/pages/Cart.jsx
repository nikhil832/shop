import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';
import OrderSummary from '../components/OrderSummary.jsx';
import PriceTag from '../components/PriceTag.jsx';
import { MAX_QTY, addToCart, cartCount, cartQuery, lineKey, removeFromCart, setQty, useCart } from '../cart.js';
import { formatPrice, mrpSavingOf, smallImage } from '../format.js';
import { CartIcon, ShieldIcon } from '../components/Icons.jsx';
import RecentlyViewed from '../components/RecentlyViewed.jsx';
import { RETURN_DAYS } from '../storeFacts.js';
import { useFetch } from '../useFetch.js';

// `qty` comes from the cart itself, so the select changes at once while the new quote loads.
// `units`: how many of this product the cart holds in all (every size and colour counts towards a quantity discount).
// `onSave(line)` moves it to the wishlist ("Save for later", stage 107); null for guests, who are asked to log in.
function CartLine({ line, qty, units, onSave }) {
  // `stock`, `price` and `mrp` are the chosen variant's, or the product's.
  const { product, problem, variant, stock } = line;
  if (!product) {
    return (
      <li className="cart-line">
        <div className="cart-line-body">
          <span className="muted">This product is no longer sold.</span>
          <button type="button" className="link" onClick={() => removeFromCart(lineKey(line))}>
            Remove
          </button>
        </div>
      </li>
    );
  }
  // Offer up to what's in stock, but keep the current quantity selectable so the select shows it.
  const options = Math.max(qty, Math.min(MAX_QTY, stock));
  return (
    <li className="cart-line">
      {/* The picture repeats the name's link next to it: a shortcut for the mouse, skipped by keyboards and screen readers. */}
      <Link to={`/p/${product.slug}`} className="cart-thumb" tabIndex={-1} aria-hidden="true">
        {(line.image ?? product.image) && (
          <img src={smallImage(line.image ?? product.image)} alt="" width="96" height="96" />
        )}
      </Link>
      <div className="cart-line-body">
        <span className="brand">{product.brand}</span>
        <Link to={`/p/${product.slug}`} className="cart-title">
          {product.title}
        </Link>
        {variant && <span className="muted small">{variant.description}</span>}
        <PriceTag price={line.price || product.price} mrp={line.mrp || product.mrp} />
        {problem && <span className="problem">{problem}</span>}
        {/* A quantity discount (stage 99): what it saves once it applies, or how many more it needs. */}
        {line.quantityDiscount &&
          (line.quantityPrice !== null ? (
            <span className="quantity-note">
              {line.quantityDiscount.percent}% off for {line.quantityDiscount.minQty} or more:{' '}
              {formatPrice(line.quantityPrice)} each
            </span>
          ) : (
            units < line.quantityDiscount.minQty && (
              <span className="quantity-note">
                Add {line.quantityDiscount.minQty - units} more for {line.quantityDiscount.percent}% off each
              </span>
            )
          ))}
        <div className="cart-actions">
          <label className="qty">
            Qty
            <select
              value={qty}
              onChange={(e) => setQty(lineKey(line), Number(e.target.value))}
              aria-label={`Quantity of ${product.title}`}
            >
              {Array.from({ length: options }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n} disabled={n > stock}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="link" onClick={() => removeFromCart(lineKey(line))}>
            Remove
          </button>
          {onSave ? (
            <button
              type="button"
              className="link"
              onClick={() => onSave(line)}
              aria-label={`Save for later: ${product.title}`}
            >
              Save for later
            </button>
          ) : (
            <Link to="/login?next=/cart" className="small">
              Log in to save for later
            </Link>
          )}
        </div>
      </div>
      <span className="line-total">{formatPrice(line.lineTotal)}</span>
    </li>
  );
}

// After "Buy again" on an order page: what went into the cart and what couldn't.
function BoughtAgain({ number, added, skipped }) {
  return (
    <div className="notice" role="status">
      <p>
        Added {added} {added === 1 ? 'item' : 'items'} from order #{number} at today&rsquo;s prices.
      </p>
      {skipped.length > 0 && <p>Not added: {skipped.map((s) => `${s.title} (${s.reason})`).join(', ')}.</p>}
    </div>
  );
}

// What the customer saved for later: their wishlist, under the cart (stage 107), the newest first. "Move to cart"
// puts one in the cart and takes it off the wishlist; products with sizes or colours go to their page to choose one,
// as the wishlist doesn't keep which.
const SAVED_SHOWN = 8;
function SavedForLater({ version, onChange }) {
  const { data: saved } = useFetch('/wishlist', version);
  const [error, setError] = useState(null);
  if (!saved?.length) return null;

  async function move(p) {
    setError(null);
    try {
      if (!addToCart(p.id, p.stock)) throw new Error('Your cart is full. Remove something to add this.');
      await request(`/wishlist/${p.id}`, { method: 'DELETE' });
      onChange();
    } catch (err) {
      setError(err.message);
    }
  }
  async function remove(p) {
    setError(null);
    try {
      await request(`/wishlist/${p.id}`, { method: 'DELETE' });
      onChange();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="panel saved-for-later" aria-labelledby="saved-heading">
      <div className="row-header">
        <h2 id="saved-heading">Saved for later ({saved.length})</h2>
        {saved.length > SAVED_SHOWN && <Link to="/wishlist">See all in your wishlist</Link>}
      </div>
      {error && <p className="error small">{error}</p>}
      <ul className="saved-list">
        {saved.slice(0, SAVED_SHOWN).map((p) => (
          <li key={p.id} className="saved-item">
            {p.image && <img src={smallImage(p.image)} alt="" width="64" height="64" />}
            <div className="saved-body">
              <Link to={`/p/${p.slug}`} className="card-title">
                {p.title}
              </Link>
              <PriceTag price={p.price} mrp={p.mrp} from={p.priceFrom} />
              <div className="cart-actions">
                {p.stock === 0 ? (
                  <span className="stock out">Out of stock</span>
                ) : p.variantName ? (
                  <Link
                    to={`/p/${p.slug}`}
                    className="btn small"
                    aria-label={`Choose a ${p.variantName.toLowerCase()}: ${p.title}`}
                  >
                    Choose a {p.variantName.toLowerCase()}
                  </Link>
                ) : (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => move(p)}
                    aria-label={`Move to cart: ${p.title}`}
                  >
                    Move to cart
                  </button>
                )}
                <button
                  type="button"
                  className="link"
                  onClick={() => remove(p)}
                  aria-label={`Remove ${p.title} from saved`}
                >
                  Remove
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Cart() {
  const items = useCart();
  const navigate = useNavigate();
  const boughtAgain = useLocation().state?.boughtAgain;
  const { user } = useAuth();
  // Bumped when something moves between the cart and the saved list.
  const [savedVersion, setSavedVersion] = useState(0);
  const [saveError, setSaveError] = useState(null);
  const savedList = user ? (
    <SavedForLater version={savedVersion} onChange={() => setSavedVersion((v) => v + 1)} />
  ) : null;
  // Moves a cart line to the wishlist (the size or colour isn't kept there).
  async function saveForLater(line) {
    setSaveError(null);
    try {
      await request(`/wishlist/${line.productId}`, { method: 'PUT' });
      removeFromCart(lineKey(line));
      setSavedVersion((v) => v + 1);
    } catch (err) {
      setSaveError(err.message);
    }
  }
  const { data: quote, error, loading } = useFetch(items.length ? `/cart?items=${cartQuery(items)}` : null);

  if (!items.length) {
    return (
      <div className="empty-state">
        <span className="empty-icon">
          <CartIcon size={40} />
        </span>
        <h1>Your cart is empty</h1>
        <p>Find something you like and add it here.</p>
        <Link to="/search" className="btn primary">
          Shop all products
        </Link>
        {savedList}
      </div>
    );
  }
  if (error) return <p className="error">{error.message}</p>;
  if (!quote) return <p className="muted">Loading…</p>;

  const qtyOf = new Map(items.map((i) => [lineKey(i), i.qty]));
  const lines = quote.items.filter((line) => qtyOf.has(lineKey(line)));
  const unitsOf = (productId) => items.filter((i) => i.productId === productId).reduce((n, i) => n + i.qty, 0);

  return (
    <>
      {boughtAgain && <BoughtAgain {...boughtAgain} />}
      <div className="cart-page">
        <section className={`panel ${loading ? 'stale' : ''}`}>
          <h1>Cart ({cartCount(items)})</h1>
          <ul className="cart-lines">
            {lines.map((line) => (
              <CartLine
                key={lineKey(line)}
                line={line}
                qty={qtyOf.get(lineKey(line))}
                units={unitsOf(line.productId)}
                onSave={user ? saveForLater : null}
              />
            ))}
          </ul>
        </section>
        <OrderSummary
          count={cartCount(quote.items)}
          subtotal={quote.subtotal}
          bundleSaving={quote.bundleSaving}
          quantitySaving={quote.quantitySaving}
          bundles={quote.bundles}
          delivery={quote.delivery}
          total={quote.total}
          freeDeliveryMin={quote.freeDeliveryMin}
          mrpSaving={mrpSavingOf(lines)}
        >
          {quote.cashback?.amount > 0 && (
            <p className="small cashback-note">
              You&apos;ll get {formatPrice(quote.cashback.amount)} back as store credit, 7 days after delivery.
            </p>
          )}
          {!quote.canCheckout && <p className="error small">Fix the items marked above to continue.</p>}
          <button
            type="button"
            className="btn primary"
            disabled={loading || !quote.canCheckout}
            onClick={() => navigate('/checkout')}
          >
            Checkout
          </button>
          <p className="reassure small">
            <ShieldIcon size={16} /> Safe checkout · Cash on Delivery or pay online · {RETURN_DAYS}-day returns
          </p>
        </OrderSummary>
      </div>
      {saveError && (
        <p className="error" role="alert">
          {saveError}
        </p>
      )}
      {savedList}
      <RecentlyViewed />
    </>
  );
}
