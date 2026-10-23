import { discountPercent, formatPrice } from '../format.js';

// `from` marks the lowest of several variant prices: "from ₹1,499".
export default function PriceTag({ price, mrp, large = false, from = false }) {
  const off = discountPercent(price, mrp);
  return (
    <span className={`price-tag ${large ? 'large' : ''}`}>
      <span className="price">
        {from && <span className="price-from">from </span>}
        {formatPrice(price)}
      </span>
      {off > 0 && (
        <>
          <s className="mrp" aria-label={`MRP ${formatPrice(mrp)}`}>
            {formatPrice(mrp)}
          </s>
          <span className="off">{off}% off</span>
        </>
      )}
    </span>
  );
}
