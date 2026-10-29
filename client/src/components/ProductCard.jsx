import { Link } from 'react-router';
import { expectedText, smallImage } from '../format.js';
import PriceTag from './PriceTag.jsx';
import Rating from './Rating.jsx';

export default function ProductCard({ product }) {
  const soldOut = product.stock === 0;
  // Not in stock yet (stage 92) rather than sold out.
  const soon = Boolean(product.comingSoon);
  return (
    <Link to={`/p/${product.slug}`} className={`card ${soldOut && !soon ? 'sold-out' : ''}`}>
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
      </div>
    </Link>
  );
}
