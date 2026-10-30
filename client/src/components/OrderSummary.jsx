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
  // How much less than MRP the items cost (paise), for "You save …" with the other savings; the cart and checkout.
  mrpSaving = 0,
  // Gift wrapping's fee (stage 104), a charge like delivery.
  giftWrap = 0,
  children,
}) {
  const short = freeDeliveryMin ? freeDeliveryMin - subtotal : 0;
  const saving = mrpSaving + bundleSaving + quantitySaving + discount;
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
        {giftWrap > 0 && (
          <>
            <dt>Gift wrapping</dt>
            <dd>{formatPrice(giftWrap)}</dd>
          </>
        )}
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
      {saving > 0 && <p className="saving-note">You save {formatPrice(saving)} on this order</p>}
      {/* How close the cart is to free delivery, as words and a bar. */}
      {freeDeliveryMin > 0 && delivery > 0 && short > 0 && (
        <div className="free-delivery">
          <p className="muted small">Add {formatPrice(short)} more for free delivery.</p>
          <span className="free-delivery-bar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, (subtotal / freeDeliveryMin) * 100)}%` }} />
          </span>
        </div>
      )}
      {children}
    </aside>
  );
}
