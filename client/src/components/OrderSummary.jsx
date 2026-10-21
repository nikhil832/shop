import { formatPrice } from '../format.js';

// Items / delivery / total box, shared by the cart, checkout and order pages. Amounts in paise.
export default function OrderSummary({ count, subtotal, delivery, total, freeDeliveryMin, children }) {
  const short = freeDeliveryMin ? freeDeliveryMin - subtotal : 0;
  return (
    <aside className="panel summary" aria-label="Order summary">
      <h2>Price details</h2>
      <dl>
        <dt>Items ({count})</dt>
        <dd>{formatPrice(subtotal)}</dd>
        <dt>Delivery</dt>
        <dd className={delivery ? '' : 'free'}>{delivery ? formatPrice(delivery) : 'Free'}</dd>
        <dt className="total">Total</dt>
        <dd className="total">{formatPrice(total)}</dd>
      </dl>
      {delivery > 0 && short > 0 && <p className="muted small">Add {formatPrice(short)} more for free delivery.</p>}
      {children}
    </aside>
  );
}
