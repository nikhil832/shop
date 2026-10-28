import { useState } from 'react';
import { Link } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';
import { formatDate, formatPrice } from '../format.js';
import { payGiftCard } from '../razorpay.js';
import { useFetch } from '../useFetch.js';

const STATUS = {
  scheduled: 'To be sent',
  sent: 'Sent',
  redeemed: 'Redeemed',
  expired: 'Ran out',
  cancelled: 'Cancelled',
};
// Today in India time, the earliest day a card can be sent.
const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const plusDays = (iso, n) =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

// "Have a gift card?": the code becomes store credit.
function Redeem({ setUser }) {
  const [state, setState] = useState({ busy: false, error: null, done: null });
  const [formKey, setFormKey] = useState(0);
  async function submit(e) {
    e.preventDefault();
    const code = new FormData(e.currentTarget).get('code');
    setState({ busy: true, error: null, done: null });
    try {
      const res = await request('/gift-cards/redeem', { method: 'POST', body: { code } });
      setState({
        busy: false,
        error: null,
        done: `${formatPrice(res.amount)} added to your store credit. You now have ${formatPrice(res.balance)}.`,
      });
      setFormKey((k) => k + 1);
      request('/auth/me').then(
        ({ user }) => user && setUser(user),
        () => {},
      );
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
    }
  }
  return (
    <section className="panel account-section" aria-labelledby="redeem-heading">
      <h2 id="redeem-heading">Redeem a gift card</h2>
      <form key={formKey} className="help-form" onSubmit={submit}>
        <label>
          Gift card code
          <input name="code" required maxLength={40} autoComplete="off" placeholder="XXXX-XXXX-XXXX-XXXX" />
        </label>
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        {state.done && <p role="status">{state.done}</p>}
        <button type="submit" className="btn primary" disabled={state.busy}>
          Add to my store credit
        </button>
      </form>
      <p className="muted small">
        It becomes <Link to="/account#credit">store credit</Link>, used at checkout. Store credit never expires.
      </p>
    </section>
  );
}

function Buy({ info, onBought }) {
  const [amount, setAmount] = useState(info.amounts[1]);
  const [when, setWhen] = useState('now');
  const [state, setState] = useState({ busy: false, error: null });
  const today = todayIst();

  async function submit(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null });
    try {
      const card = await request('/gift-cards', {
        method: 'POST',
        body: {
          amount,
          recipientName: f.recipientName,
          recipientEmail: f.recipientEmail,
          message: f.message,
          ...(when === 'later' && { sendOn: f.sendOn }),
        },
      });
      const paid = await payGiftCard(card, card.checkout);
      setState({ busy: false, error: null });
      if (paid) onBought(paid);
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <form className="help-form" onSubmit={submit} aria-labelledby="buy-heading">
      <fieldset className="gift-amounts">
        <legend>Amount</legend>
        {info.amounts.map((a) => (
          <label key={a} className={`gift-amount ${amount === a ? 'chosen' : ''}`}>
            <input type="radio" name="amount" checked={amount === a} onChange={() => setAmount(a)} />
            {formatPrice(a)}
          </label>
        ))}
      </fieldset>
      <label>
        Their name
        <input name="recipientName" required maxLength={80} />
      </label>
      <label>
        Their email
        <input name="recipientEmail" type="email" required maxLength={254} />
      </label>
      <label>
        A message (optional)
        <textarea name="message" rows={3} maxLength={300} placeholder="Happy Diwali!" />
      </label>
      <fieldset className="payment-options">
        <legend>Send it</legend>
        <label className="check">
          <input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} />
          As soon as it&apos;s paid
        </label>
        <label className="check">
          <input type="radio" name="when" checked={when === 'later'} onChange={() => setWhen('later')} />
          On a day I choose
        </label>
        {when === 'later' && (
          <label>
            Day (sent at 9 am)
            <input
              name="sendOn"
              type="date"
              required
              min={plusDays(today, 1)}
              max={plusDays(today, info.maxAheadDays)}
            />
          </label>
        )}
      </fieldset>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" className="btn primary" disabled={state.busy}>
        {state.busy ? 'Opening payment…' : `Pay ${formatPrice(amount)}`}
      </button>
      <p className="muted small">
        Paid online. They have a year to redeem it; you get a copy of the code by email too.
      </p>
    </form>
  );
}

// /gift-cards (stage 77): buy a gift card for someone (paid online, emailed now or on a chosen day), redeem one into
// store credit, and see the cards you bought.
export default function GiftCards() {
  const { user, setUser } = useAuth();
  const [version, setVersion] = useState(0);
  const [bought, setBought] = useState(null);
  const { data: info, error } = useFetch(user === undefined ? null : '/gift-cards', version);

  if (error) return <p className="error">{error.message}</p>;
  if (!info) return <p className="muted">Loading…</p>;

  return (
    <div className="orders-page">
      <title>Gift cards · Bazaar</title>
      <section className="panel account-section" aria-labelledby="buy-heading">
        <h1 id="buy-heading">Gift cards</h1>
        <p>
          Send someone a Bazaar gift card by email. They redeem the code as store credit and spend it on anything in the
          store.
        </p>
        {bought && (
          <p role="status" className="notice">
            Paid! Your {formatPrice(bought.amount)} gift card for {bought.recipient.name}{' '}
            {bought.status === 'scheduled'
              ? `will be emailed on ${formatDate(bought.sendAt)}`
              : `has been emailed to ${bought.recipient.email}`}
            .
          </p>
        )}
        {!info.available ? (
          <p className="muted">Gift cards are paid online, which isn&apos;t available right now.</p>
        ) : user ? (
          <Buy
            key={version}
            info={info}
            onBought={(card) => {
              setBought(card);
              setVersion((v) => v + 1);
            }}
          />
        ) : (
          <p>
            <Link to="/login?next=/gift-cards">Log in</Link> or <Link to="/register">create an account</Link> to buy or
            redeem a gift card.
          </p>
        )}
      </section>

      {user && <Redeem setUser={setUser} />}

      {info.bought.length > 0 && (
        <section className="panel account-section" aria-labelledby="bought-heading">
          <h2 id="bought-heading">Gift cards you bought</h2>
          <ul className="plain-list">
            {info.bought.map((c) => (
              <li key={c.id}>
                <strong>{formatPrice(c.amount)}</strong> for {c.recipient.name} ({c.recipient.email}) ·{' '}
                {STATUS[c.status] ?? c.status}
                <span className="muted small block">
                  {c.status === 'scheduled'
                    ? `Goes on ${formatDate(c.sendAt)}`
                    : c.sentAt && `Sent ${formatDate(c.sentAt)}`}
                  {c.redeemedAt && ` · redeemed ${formatDate(c.redeemedAt)}`}
                  {c.status === 'sent' && c.expiresAt && ` · can be redeemed until ${formatDate(c.expiresAt)}`}
                  {c.last4 && ` · code ending ${c.last4}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
