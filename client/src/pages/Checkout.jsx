import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';
import { cartCount, cartQuery, clearCart, useCart } from '../cart.js';
import OrderSummary from '../components/OrderSummary.jsx';
import { formatPrice } from '../format.js';
import { payOrder } from '../razorpay.js';
import { useFetch } from '../useFetch.js';

const FIELDS = [
  { name: 'name', label: 'Full name', autoComplete: 'name', maxLength: 80 },
  {
    name: 'phone',
    label: 'Mobile number',
    autoComplete: 'tel-national',
    inputMode: 'numeric',
    pattern: '[6-9][0-9]{9}',
    title: '10-digit mobile number',
    maxLength: 10,
  },
  { name: 'line1', label: 'Address (house, street, area)', autoComplete: 'address-line1', maxLength: 120, wide: true },
  {
    name: 'line2',
    label: 'Landmark (optional)',
    autoComplete: 'address-line2',
    maxLength: 120,
    required: false,
    wide: true,
  },
  { name: 'city', label: 'City', autoComplete: 'address-level2', maxLength: 60 },
  { name: 'state', label: 'State', autoComplete: 'address-level1', maxLength: 60 },
  {
    name: 'pincode',
    label: 'PIN code',
    autoComplete: 'postal-code',
    inputMode: 'numeric',
    pattern: '[1-9][0-9]{5}',
    title: '6-digit PIN code',
    maxLength: 6,
  },
];

export default function Checkout() {
  const { user, setUser } = useAuth();
  const items = useCart();
  const navigate = useNavigate();
  const [state, setState] = useState({ busy: false, error: null, version: 0 });
  const { data: options } = useFetch('/payments/options');
  const {
    data: quote,
    error,
    loading,
  } = useFetch(user && items.length ? `/cart?items=${cartQuery(items)}` : null, state.version);

  if (user === undefined) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to="/login?next=/checkout" replace />;
  if (!items.length && !state.busy) return <Navigate to="/cart" replace />;
  if (error) return <p className="error">{error.message}</p>;
  if (!quote) return <p className="muted">Loading…</p>;

  async function submit(e) {
    e.preventDefault();
    const { paymentMethod = 'cod', ...address } = Object.fromEntries(new FormData(e.currentTarget));
    setState((s) => ({ ...s, busy: true, error: null }));
    let order;
    try {
      order = await request('/orders', {
        method: 'POST',
        body: { items, address, expectedTotal: quote.total, paymentMethod },
      });
    } catch (err) {
      if (err.status === 401) return setUser(null);
      // Stock or prices changed: show why and load the current quote.
      return setState((s) => ({ busy: false, error: err.message, version: s.version + (err.status === 409 ? 1 : 0) }));
    }
    // The order exists now (with its stock reserved), so the cart is done with either way.
    setUser({ ...user, address: order.address });
    clearCart();
    const goToOrder = (state) => navigate(`/orders/${order.id}`, { replace: true, state });
    if (!order.checkout) return goToOrder({ placed: true });
    try {
      const paid = await payOrder(order, order.checkout);
      // Closed without paying: the order page offers "Pay now" until the payment window ends.
      goToOrder(paid ? { placed: true } : null);
    } catch (err) {
      goToOrder({ paymentError: err.message });
    }
  }

  const saved = user.address ?? {};

  return (
    <form className="cart-page" onSubmit={submit}>
      <div className="checkout-main">
        <section className="panel">
          <h1>Delivery address</h1>
          {/* Remounted per user so the saved address fills in. */}
          <div key={user.id} className="address-grid">
            {FIELDS.map(({ name, label, wide, required = true, ...input }) => (
              <label key={name} className={wide ? 'wide' : ''}>
                {label}
                <input
                  name={name}
                  defaultValue={saved[name] ?? (name === 'name' ? user.name : '')}
                  required={required}
                  {...input}
                />
              </label>
            ))}
          </div>
        </section>

        <fieldset className="panel payment-options">
          <legend>
            <h2>Payment</h2>
          </legend>
          {options?.online && (
            <label className="payment-option">
              <input type="radio" name="paymentMethod" value="razorpay" defaultChecked />
              <span>
                <strong>Pay online</strong>
                <span className="muted small block">UPI, cards, netbanking or wallets, via Razorpay (test mode).</span>
              </span>
            </label>
          )}
          <label className="payment-option">
            {options?.online && <input type="radio" name="paymentMethod" value="cod" />}
            <span>
              <strong>Cash on Delivery</strong>
              <span className="muted small block">Pay in cash when your order arrives.</span>
            </span>
          </label>
        </fieldset>

        <section className={`panel ${loading ? 'stale' : ''}`}>
          <div className="row-header">
            <h2>Items ({cartCount(items)})</h2>
            <Link to="/cart">Change</Link>
          </div>
          <ul className="checkout-items">
            {quote.items.map((line) => (
              <li key={line.productId}>
                <span>
                  {line.product?.title ?? 'Unavailable item'} × {line.qty}
                  {line.problem && <span className="problem"> · {line.problem}</span>}
                </span>
                <span>{formatPrice(line.lineTotal)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <OrderSummary
        count={cartCount(quote.items)}
        subtotal={quote.subtotal}
        delivery={quote.delivery}
        total={quote.total}
        freeDeliveryMin={quote.freeDeliveryMin}
      >
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        {!quote.canCheckout && !state.error && (
          <p className="error small">
            Some items can't be ordered. <Link to="/cart">Review your cart</Link>.
          </p>
        )}
        <button
          type="submit"
          className="btn primary"
          disabled={state.busy || loading || !quote.canCheckout || !options}
        >
          {state.busy ? 'Placing order…' : `Place order · ${formatPrice(quote.total)}`}
        </button>
      </OrderSummary>
    </form>
  );
}
