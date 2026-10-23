import { Link } from 'react-router';
import PriceTag from './PriceTag.jsx';
import Rating from './Rating.jsx';

export default function ProductCard({ product }) {
  const soldOut = product.stock === 0;
  return (
    <Link to={`/p/${product.slug}`} className={`card ${soldOut ? 'sold-out' : ''}`}>
      <div className="card-image">
        {product.image && <img src={product.image} alt="" loading="lazy" width="300" height="300" />}
        {soldOut && <span className="ribbon">Out of stock</span>}
      </div>
      <div className="card-body">
        <span className="brand">{product.brand}</span>
        <span className="card-title">{product.title}</span>
        <Rating rating={product.rating} />
        <PriceTag price={product.price} mrp={product.mrp} from={product.priceFrom} />
        {!soldOut && product.stock <= 5 && <span className="low-stock">Only {product.stock} left</span>}
      </div>
    </Link>
  );
}
