import { Link, useLocation, useNavigate } from 'react-router';
import OrderSummary from '../components/OrderSummary.jsx';
import PriceTag from '../components/PriceTag.jsx';
import { MAX_QTY, cartCount, cartQuery, lineKey, removeFromCart, setQty, useCart } from '../cart.js';
import { formatPrice, smallImage } from '../format.js';
import { useFetch } from '../useFetch.js';

// `qty` comes from the cart itself, so the select changes at once while the new quote loads.
// `units`: how many of this product the cart holds in all (every size and colour counts towards a quantity discount).
function CartLine({ line, qty, units }) {
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

export default function Cart() {
  const items = useCart();
  const navigate = useNavigate();
  const boughtAgain = useLocation().state?.boughtAgain;
  const { data: quote, error, loading } = useFetch(items.length ? `/cart?items=${cartQuery(items)}` : null);

  if (!items.length) {
    return (
      <div className="empty-state">
        <h1>Your cart is empty</h1>
        <p>Find something you like and add it here.</p>
        <Link to="/search" className="btn primary">
          Shop all products
        </Link>
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
        </OrderSummary>
      </div>
    </>
  );
}
