import { discountPercent, formatPrice } from '../format.js';

export default function PriceTag({ price, mrp, large = false }) {
  const off = discountPercent(price, mrp);
  return (
    <span className={`price-tag ${large ? 'large' : ''}`}>
      <span className="price">{formatPrice(price)}</span>
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
