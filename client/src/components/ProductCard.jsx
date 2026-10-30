import { useState } from 'react';
import { Link } from 'react-router';
import { MAX_QTY, addToCart, qtyInCart, useCart } from '../cart.js';
import { expectedText, smallImage } from '../format.js';
import { reportSeen } from '../productStats.js';
import { CartIcon } from './Icons.jsx';
import PriceTag from './PriceTag.jsx';
import Rating from './Rating.jsx';

// "Add" on a card, for products without sizes or colours that are in stock: one more in the cart, without opening the
// product. Its name says which product ("Add … to cart"), as a page can show many; "Added" shows for a moment after.
function QuickAdd({ product }) {
  const items = useCart();
  const [added, setAdded] = useState(false);
  const full = qtyInCart(items, product.id) >= Math.min(MAX_QTY, product.stock);
  function add() {
    if (!addToCart(product.id, product.stock)) return;
    reportSeen(product.slug, 'cart');
    setAdded(true);
    setTimeout(() => setAdded(false), 1500);
  }
  return (
    <button
      type="button"
      className={`btn small card-add ${added ? 'added' : ''}`}
      onClick={add}
      disabled={full && !added}
      aria-label={
        full && !added ? `${product.title}: as many as possible in your cart` : `Add ${product.title} to cart`
      }
    >
      <CartIcon size={16} />
      {added ? 'Added' : full ? 'In cart' : 'Add'}
      {/* Read out once added (not role="status": tests look for the page's own status messages). */}
      <span className="sr-only" aria-live="polite">
        {added ? `${product.title} added to your cart` : ''}
      </span>
    </button>
  );
}

// A product in a grid or row: one link to its page (picture, name, rating, price), and "Add" under it when it can be
// bought straight away. The link and the button are siblings, as a button inside a link isn't allowed.
export default function ProductCard({ product }) {
  const soldOut = product.stock === 0;
  // Not in stock yet (stage 92) rather than sold out.
  const soon = Boolean(product.comingSoon);
  const quickAdd = !soldOut && !soon && !product.variantName;
  return (
    <div className={`card ${soldOut && !soon ? 'sold-out' : ''}`}>
      <Link to={`/p/${product.slug}`} className="card-link">
        <div className="card-image">
          {product.image && <img src={smallImage(product.image)} alt="" loading="lazy" width="300" height="300" />}
          {soon ? (
            <span className="ribbon soon">Coming soon</span>
          ) : soldOut ? (
            <span className="ribbon">Out of stock</span>
          ) : (
            product.sale && <span className="ribbon sale">Sale</span>
          )}
        </div>
        <div className="card-body">
          <span className="brand">{product.brand}</span>
          <span className="card-title">{product.title}</span>
          <Rating rating={product.rating} />
          <PriceTag price={product.price} mrp={product.mrp} from={product.priceFrom} />
          {!soldOut && product.stock <= 5 && <span className="low-stock">Only {product.stock} left</span>}
          {soon && expectedText(product.comingSoon) && (
            <span className="muted small">{expectedText(product.comingSoon)}</span>
          )}
          {product.variantName && !soldOut && !soon && (
            <span className="muted small">{product.variantName} options available</span>
          )}
        </div>
      </Link>
      {quickAdd && (
        <div className="card-actions">
          <QuickAdd product={product} />
        </div>
      )}
    </div>
  );
}
