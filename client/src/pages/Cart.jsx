import { Link, useNavigate } from 'react-router';
import OrderSummary from '../components/OrderSummary.jsx';
import PriceTag from '../components/PriceTag.jsx';
import { MAX_QTY, cartCount, cartQuery, removeFromCart, setQty, useCart } from '../cart.js';
import { formatPrice } from '../format.js';
import { useFetch } from '../useFetch.js';

// `qty` comes from the cart itself, so the select changes at once while the new quote loads.
function CartLine({ line, qty }) {
  const { product, problem } = line;
  if (!product) {
    return (
      <li className="cart-line">
        <div className="cart-line-body">
          <span className="muted">This product is no longer sold.</span>
          <button type="button" className="link" onClick={() => removeFromCart(line.productId)}>
            Remove
          </button>
        </div>
      </li>
    );
  }
  // Offer up to what's in stock, but keep the current quantity selectable so the select shows it.
  const options = Math.max(qty, Math.min(MAX_QTY, product.stock));
  return (
    <li className="cart-line">
      <Link to={`/p/${product.slug}`} className="cart-thumb">
        {product.image && <img src={product.image} alt="" width="96" height="96" />}
      </Link>
      <div className="cart-line-body">
        <span className="brand">{product.brand}</span>
        <Link to={`/p/${product.slug}`} className="cart-title">
          {product.title}
        </Link>
        <PriceTag price={product.price} mrp={product.mrp} />
        {problem && <span className="problem">{problem}</span>}
        <div className="cart-actions">
          <label className="qty">
            Qty
            <select
              value={qty}
              onChange={(e) => setQty(line.productId, Number(e.target.value))}
              aria-label={`Quantity of ${product.title}`}
            >
              {Array.from({ length: options }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n} disabled={n > product.stock}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="link" onClick={() => removeFromCart(line.productId)}>
            Remove
          </button>
        </div>
      </div>
      <span className="line-total">{formatPrice(line.lineTotal)}</span>
    </li>
  );
}

export default function Cart() {
  const items = useCart();
  const navigate = useNavigate();
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

  const qtyOf = new Map(items.map((i) => [i.productId, i.qty]));
  const lines = quote.items.filter((line) => qtyOf.has(line.productId));

  return (
    <div className="cart-page">
      <section className={`panel ${loading ? 'stale' : ''}`}>
        <h1>Cart ({cartCount(items)})</h1>
        <ul className="cart-lines">
          {lines.map((line) => (
            <CartLine key={line.productId} line={line} qty={qtyOf.get(line.productId)} />
          ))}
        </ul>
      </section>
      <OrderSummary
        count={cartCount(quote.items)}
        subtotal={quote.subtotal}
        delivery={quote.delivery}
        total={quote.total}
        freeDeliveryMin={quote.freeDeliveryMin}
      >
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
  );
}
