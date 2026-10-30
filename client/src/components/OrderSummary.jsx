import { formatPrice } from '../format.js';

// Items / delivery / coupon / total box, shared by the cart, checkout and order pages. Amounts in paise.
export default function OrderSummary({
  count,
  subtotal,
  delivery,
  discount = 0,
  couponCode,
  // What the discount is, when not a coupon: a referred friend's welcome (stage 87).
  discountLabel = null,
  total,
  freeDeliveryMin,
  // Store credit paying part of `total` (stage 72), and what to call the rest ("To pay on delivery").
  creditUsed = 0,
  // Bundle savings (stage 83): `subtotal` is after them, so Items shows the prices before.
  bundleSaving = 0,
  bundles = [],
  // Quantity discounts (stage 99), likewise already taken off `subtotal`.
  quantitySaving = 0,
  dueLabel = 'To pay',
  children,
}) {
  const short = freeDeliveryMin ? freeDeliveryMin - subtotal : 0;
  return (
    <aside className="panel summary" aria-label="Order summary">
      <h2>Price details</h2>
      <dl>
        <dt>Items ({count})</dt>
        <dd>{formatPrice(subtotal + bundleSaving + quantitySaving)}</dd>
        {bundleSaving > 0 && (
          <>
            <dt>
              Bundle savings
              {bundles.length > 0 && <span className="muted small block">{bundles.map((b) => b.name).join(', ')}</span>}
            </dt>
            <dd className="free">−{formatPrice(bundleSaving)}</dd>
          </>
        )}
        {quantitySaving > 0 && (
          <>
            <dt>Quantity discounts</dt>
            <dd className="free">−{formatPrice(quantitySaving)}</dd>
          </>
        )}
        <dt>Delivery</dt>
        <dd className={delivery ? '' : 'free'}>{delivery ? formatPrice(delivery) : 'Free'}</dd>
        {discount > 0 && (
          <>
            <dt>{discountLabel ?? <>Coupon{couponCode && ` (${couponCode})`}</>}</dt>
            <dd className="free">−{formatPrice(discount)}</dd>
          </>
        )}
        <dt className="total">Total</dt>
        <dd className="total">{formatPrice(total)}</dd>
        {creditUsed > 0 && (
          <>
            <dt>Store credit</dt>
            <dd className="free">−{formatPrice(creditUsed)}</dd>
            <dt className="total">{dueLabel}</dt>
            <dd className="total">{formatPrice(total - creditUsed)}</dd>
          </>
        )}
      </dl>
      {delivery > 0 && short > 0 && <p className="muted small">Add {formatPrice(short)} more for free delivery.</p>}
      {children}
    </aside>
  );
}
