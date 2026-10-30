import { useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';
import { cartCount, cartQuery, clearCart, lineKey, useCart } from '../cart.js';
import AddressFields from '../components/AddressFields.jsx';
import OrderSummary from '../components/OrderSummary.jsx';
import { MAX_ADDRESSES, addressFields, addressLine, formatPrice, arrival } from '../format.js';
import { payOrder } from '../razorpay.js';
import { useFetch } from '../useFetch.js';
import { referralCode } from '../referral.js';

// Inside the checkout form, so it is not a form itself: Enter applies the code instead of placing the order, and the
// input has no name, so it isn't sent as part of the address.
function CouponBox({ applied, error, inputRef, onApply, onRemove }) {
  if (applied) {
    return (
      <p className="coupon-applied">
        <span>
          <strong>{applied.code}</strong> applied
        </span>
        <button type="button" className="link" onClick={onRemove}>
          Remove
        </button>
      </p>
    );
  }
  return (
    <div className="coupon-box">
      <div className="coupon-row">
        <input
          ref={inputRef}
          aria-label="Coupon code"
          placeholder="Coupon code"
          maxLength={20}
          autoCapitalize="characters"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onApply();
            }
          }}
        />
        <button type="button" className="btn small" onClick={onApply}>
          Apply
        </button>
      </div>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// Where to deliver: one of the saved addresses (the default first and chosen), or a new one, which is saved to the
// address book unless "Save it" is unticked. The radios and the checkbox have names the submit handler takes out.
function DeliveryAddress({ user }) {
  const [choice, setChoice] = useState(user.addresses[0]?.id ?? 'new');
  const full = user.addresses.length >= MAX_ADDRESSES;
  const newFields = (
    <>
      <AddressFields defaultName={user.name} />
      {full ? (
        <p className="muted small">
          Your address book is full ({MAX_ADDRESSES}), so this one isn&apos;t saved.{' '}
          <Link to="/account#addresses">Manage addresses</Link>
        </p>
      ) : (
        <label className="check">
          <input type="checkbox" name="saveAddress" defaultChecked />
          Save it to my addresses
        </label>
      )}
    </>
  );
  if (!user.addresses.length) {
    return (
      <section className="panel">
        <h1>Delivery address</h1>
        {newFields}
      </section>
    );
  }
  return (
    <fieldset className="panel address-choices">
      <legend>
        <h1>Delivery address</h1>
      </legend>
      {user.addresses.map((a, i) => (
        <label key={a.id} className="address-choice">
          <input
            type="radio"
            name="addressChoice"
            value={a.id}
            checked={choice === a.id}
            onChange={() => setChoice(a.id)}
          />
          <span>
            <strong>{a.label || a.name}</strong>
            {i === 0 && <span className="status">Default</span>}
            <span className="muted small block">
              {a.label && `${a.name}, `}
              {addressLine(a)} · {a.phone}
            </span>
          </span>
        </label>
      ))}
      <label className="address-choice">
        <input
          type="radio"
          name="addressChoice"
          value="new"
          checked={choice === 'new'}
          onChange={() => setChoice('new')}
        />
        <span>
          <strong>A new address</strong>
        </span>
      </label>
      {choice === 'new' && newFields}
      <p className="small">
        <Link to="/account#addresses">Manage addresses</Link>
      </p>
    </fieldset>
  );
}

// When it would arrive at the PIN code being ordered to (stage 86), from the delivery areas; nothing until there's a
// 6-digit PIN code.
function Arrival({ pincode }) {
  const { data } = useFetch(/^[1-9]\d{5}$/.test(pincode ?? '') ? `/delivery?pincode=${pincode}` : null);
  if (!data) return null;
  return (
    <p className={`small arrival ${data.deliverable ? '' : 'error'}`}>
      {data.deliverable ? `Arrives ${arrival(data)}` : `Sorry, we don't deliver to ${data.pincode} yet.`}
    </p>
  );
}

// A visitor who isn't logged in (stage 84): no saved addresses yet; the account is made when they order.
const NEW_CUSTOMER = { name: '', addresses: [] };

// Name and email for checking out without an account; the account is made with them, and the confirmation email
// brings a link to set a password.
function NewCustomerDetails() {
  return (
    <section className="panel" aria-labelledby="details-heading">
      <h1 id="details-heading">Your details</h1>
      <p className="small">
        Already have an account? <Link to="/login?next=/checkout">Log in</Link>
      </p>
      <div className="address-grid">
        <label>
          Your name
          <input name="buyerName" required maxLength={80} autoComplete="name" />
        </label>
        <label>
          Email
          <input name="buyerEmail" type="email" required maxLength={254} autoComplete="email" />
        </label>
      </div>
      <p className="muted small">
        We&apos;ll make you an account to follow your order, and email a link to set a password.
      </p>
    </section>
  );
}

export default function Checkout() {
  const { user, setUser } = useAuth();
  const items = useCart();
  const navigate = useNavigate();
  const [state, setState] = useState({ busy: false, error: null, version: 0 });
  // The coupon code being tried; the quote says whether it applies (quote.coupon) or why not (quote.couponError).
  const [coupon, setCoupon] = useState('');
  // Store credit is used unless the customer unticks it (stage 72).
  const [useCredit, setUseCredit] = useState(true);
  // The PIN code the order would go to: a saved address's, or what's typed (null: the default address's).
  const [pin, setPin] = useState(null);
  const couponInput = useRef(null);
  const { data: options } = useFetch('/payments/options');
  const {
    data: quote,
    error,
    loading,
  } = useFetch(
    user !== undefined && items.length
      ? `/cart?items=${cartQuery(items)}${coupon ? `&coupon=${encodeURIComponent(coupon)}` : ''}${!user && referralCode() ? `&ref=${referralCode()}` : ''}`
      : null,
    state.version,
  );

  if (user === undefined) return <p className="muted">Loading…</p>;
  if (!items.length && !state.busy) return <Navigate to="/cart" replace />;
  if (error) return <p className="error">{error.message}</p>;
  if (!quote) return <p className="muted">Loading…</p>;
  const balance = user?.credit ?? 0;
  const creditToUse = useCredit ? Math.min(balance, quote.total) : 0;
  const due = quote.total - creditToUse;
  // Why this order can't be paid on delivery (stage 79): this customer's COD orders keep coming back, or it's over
  // the store's COD limit. The server checks the same when the order is placed.
  const codBlocked = !options
    ? null
    : !options.cod
      ? options.codReason
      : options.codMax !== null && due > options.codMax
        ? `Cash on Delivery is for orders up to ${formatPrice(options.codMax)}; please pay online.`
        : null;
  const cannotPay = due > 0 && codBlocked && !options?.online;

  async function submit(e) {
    e.preventDefault();
    const {
      paymentMethod = 'cod',
      addressChoice = 'new',
      saveAddress,
      buyerName,
      buyerEmail,
      ...typed
    } = Object.fromEntries(new FormData(e.currentTarget));
    const saved = user?.addresses.find((a) => a.id === addressChoice);
    const address = saved ? addressFields(saved) : typed;
    setState((s) => ({ ...s, busy: true, error: null }));
    let order;
    // Not logged in: make the account first (it logs this browser in), then order as any customer.
    if (!user) {
      try {
        const made = await request('/auth/quick-account', {
          method: 'POST',
          body: { name: buyerName, email: buyerEmail, ...(referralCode() && { ref: referralCode() }) },
        });
        setUser(made.user);
      } catch (err) {
        return setState((s) => ({ ...s, busy: false, error: err.message }));
      }
    }
    try {
      order = await request('/orders', {
        method: 'POST',
        body: {
          items,
          address,
          saveAddress: !saved && saveAddress === 'on',
          expectedTotal: quote.total,
          paymentMethod,
          couponCode: quote.coupon?.code,
          creditToUse,
        },
      });
    } catch (err) {
      if (err.status === 401) return setUser(null);
      // The balance may have changed in another tab: load it again.
      if (err.status === 409) {
        request('/auth/me').then(
          ({ user }) => user && setUser(user),
          () => {},
        );
      }
      // Stock or prices changed: show why and load the current quote.
      return setState((s) => ({ busy: false, error: err.message, version: s.version + (err.status === 409 ? 1 : 0) }));
    }
    // The order exists now (with its stock reserved), so the cart is done with either way.
    // A new address may have gone into the address book.
    if (!saved || creditToUse)
      request('/auth/me').then(
        ({ user }) => user && setUser(user),
        () => {},
      );
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

  return (
    <form
      className="cart-page"
      onSubmit={submit}
      onChange={(e) => {
        if (e.target.name === 'pincode') setPin(e.target.value.trim());
        if (e.target.name === 'addressChoice') {
          setPin(user?.addresses.find((a) => a.id === e.target.value)?.pincode ?? '');
        }
      }}
    >
      <div className="checkout-main">
        {/* Remounted per user, so another account's choice doesn't carry over. */}
        {!user && <NewCustomerDetails />}
        {/* Remounted per account with saved addresses, so another account's choice doesn't carry over; a new
            customer's typed address stays when their account is made. */}
        <DeliveryAddress key={user?.addresses.length ? user.id : 'no-addresses'} user={user ?? NEW_CUSTOMER} />

        <fieldset className="panel payment-options">
          <legend>
            <h2>Payment</h2>
          </legend>
          {balance > 0 && (
            <label className="payment-option">
              <input type="checkbox" checked={useCredit} onChange={(e) => setUseCredit(e.target.checked)} />
              <span>
                <strong>Use my store credit</strong>
                <span className="muted small block">
                  {formatPrice(balance)} available
                  {useCredit &&
                    (due === 0 ? ': pays for the whole order.' : `: ${formatPrice(creditToUse)} of it now.`)}
                </span>
              </span>
            </label>
          )}
          {due > 0 && options?.online && (
            <label className="payment-option">
              <input type="radio" name="paymentMethod" value="razorpay" defaultChecked />
              <span>
                <strong>Pay online</strong>
                <span className="muted small block">UPI, cards, netbanking or wallets, via Razorpay (test mode).</span>
              </span>
            </label>
          )}
          {due > 0 && (
            <label className={`payment-option ${codBlocked ? 'disabled' : ''}`}>
              {options?.online && (
                <input type="radio" name="paymentMethod" value="cod" disabled={Boolean(codBlocked)} />
              )}
              <span>
                <strong>Cash on Delivery</strong>
                <span className="muted small block">{codBlocked ?? 'Pay in cash when your order arrives.'}</span>
              </span>
            </label>
          )}
          {cannotPay && (
            <p className="error small">
              Online payment isn&apos;t available right now either. <Link to="/help">Contact us</Link> to order.
            </p>
          )}
        </fieldset>

        <section className={`panel ${loading ? 'stale' : ''}`}>
          <div className="row-header">
            <h2>Items ({cartCount(items)})</h2>
            <Link to="/cart">Change</Link>
          </div>
          <ul className="checkout-items">
            {quote.items.map((line) => (
              <li key={lineKey(line)}>
                <span>
                  {line.product?.title ?? 'Unavailable item'}
                  {line.variant && ` (${line.variant.description})`} × {line.qty}
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
        bundleSaving={quote.bundleSaving}
        quantitySaving={quote.quantitySaving}
        bundles={quote.bundles}
        delivery={quote.delivery}
        discount={quote.discount}
        couponCode={quote.coupon?.code}
        discountLabel={quote.referral ? "Friend's welcome" : null}
        total={quote.total}
        freeDeliveryMin={quote.freeDeliveryMin}
        creditUsed={creditToUse}
      >
        {quote.cashback?.amount > 0 && (
          <p className="small cashback-note">
            You&apos;ll get {formatPrice(quote.cashback.amount)} back as store credit, 7 days after delivery.
          </p>
        )}
        <CouponBox
          applied={quote.coupon}
          error={coupon && !loading ? quote.couponError : null}
          inputRef={couponInput}
          onApply={() => setCoupon(couponInput.current.value.trim())}
          onRemove={() => setCoupon('')}
        />
        <Arrival pincode={pin ?? user?.addresses[0]?.pincode} />
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
          disabled={state.busy || loading || !quote.canCheckout || !options || cannotPay}
        >
          {state.busy ? 'Placing order…' : `Place order · ${formatPrice(due)}`}
        </button>
      </OrderSummary>
    </form>
  );
}
