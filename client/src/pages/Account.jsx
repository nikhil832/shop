import { useState } from 'react';
import { Navigate } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';
import AccountNav from '../components/AccountNav.jsx';
import AddressFields from '../components/AddressFields.jsx';
import TwoStepSection from '../components/TwoStepSection.jsx';
import { useFetch } from '../useFetch.js';

// Each section saves on its own: { busy, error, done } where `done` is the confirmation to show.
function useSave() {
  const [state, setState] = useState({ busy: false, error: null, done: null });
  async function save(action, done) {
    setState({ busy: true, error: null, done: null });
    try {
      await action();
      setState({ busy: false, error: null, done });
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
    }
  }
  return [state, save];
}

function Feedback({ state }) {
  if (state.error) {
    return (
      <p className="error" role="alert">
        {state.error}
      </p>
    );
  }
  return state.done && <p role="status">{state.done}</p>;
}

export default function Account() {
  const { user, setUser } = useAuth();
  const [details, saveDetails] = useSave();
  const [address, saveAddress] = useSave();
  const [password, savePassword] = useSave();
  const [emailChange, saveEmailChange] = useSave();
  const [updates, saveUpdates] = useSave();
  // Bumped to reload the pending email change after asking for one or cancelling it.
  const [emailVersion, setEmailVersion] = useState(0);
  const { data: pending } = useFetch(user ? '/account/email' : null, emailVersion);
  // Bumped to remount the address inputs after removing it (they are uncontrolled).
  const [addressVersion, setAddressVersion] = useState(0);

  if (user === undefined) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to="/login?next=/account" replace />;

  const fields = (e) => Object.fromEntries(new FormData(e.currentTarget));

  function submitDetails(e) {
    e.preventDefault();
    const { name } = fields(e);
    saveDetails(async () => setUser((await request('/account', { method: 'PATCH', body: { name } })).user), 'Saved');
  }

  // Saved as soon as it's ticked or unticked.
  function changePriceDrops(e) {
    const priceDropEmails = e.target.checked;
    saveUpdates(
      async () =>
        setUser((await request('/account/email-preferences', { method: 'PUT', body: { priceDropEmails } })).user),
      priceDropEmails ? 'Price-drop emails are on.' : 'Price-drop emails are off.',
    );
  }

  function submitAddress(e) {
    e.preventDefault();
    const body = { address: fields(e) };
    saveAddress(
      async () => setUser((await request('/account/address', { method: 'PUT', body })).user),
      'Saved. Checkout will fill this in.',
    );
  }

  function removeAddress() {
    saveAddress(async () => {
      setUser((await request('/account/address', { method: 'DELETE' })).user);
      setAddressVersion((v) => v + 1);
    }, 'Address removed');
  }

  function submitPassword(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const { currentPassword, newPassword, confirm } = fields(e);
    savePassword(async () => {
      if (newPassword !== confirm) throw new Error("The two new passwords don't match");
      await request('/account/password', { method: 'POST', body: { currentPassword, newPassword } });
      form.reset();
    }, "Password changed. You've been logged out on your other devices.");
  }

  function submitEmail(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const { newEmail, password } = fields(e);
    saveEmailChange(async () => {
      await request('/account/email', { method: 'POST', body: { newEmail, password } });
      form.reset();
      setEmailVersion((v) => v + 1);
    }, 'Check your inbox at the new address and open the link to finish.');
  }

  function cancelEmail() {
    saveEmailChange(async () => {
      await request('/account/email', { method: 'DELETE' });
      setEmailVersion((v) => v + 1);
    }, 'Email change cancelled.');
  }

  return (
    <div className="orders-page">
      <AccountNav />

      <form className="panel account-section" onSubmit={submitDetails} aria-labelledby="details-heading">
        <h1 id="details-heading">Your details</h1>
        <label>
          Name
          <input name="name" defaultValue={user.name} autoComplete="name" required maxLength={80} />
        </label>
        <Feedback state={details} />
        <button type="submit" className="btn primary" disabled={details.busy}>
          Save
        </button>
      </form>

      <form className="panel account-section" onSubmit={submitEmail} aria-labelledby="email-heading">
        <h2 id="email-heading">Email</h2>
        <p>
          You log in with <strong>{user.email}</strong>. Order emails go there too.
        </p>
        {pending?.pendingEmail && (
          <div className="notice" role="status">
            <p>
              Waiting for you to confirm <strong>{pending.pendingEmail}</strong>: open the link we sent there. Until
              then nothing changes.
            </p>
            <button type="button" className="btn" onClick={cancelEmail} disabled={emailChange.busy}>
              Cancel the change
            </button>
          </div>
        )}
        <label>
          New email
          <input name="newEmail" type="email" autoComplete="email" required maxLength={254} />
        </label>
        <label>
          Your password
          <input name="password" type="password" autoComplete="current-password" required maxLength={128} />
        </label>
        <Feedback state={emailChange} />
        <button type="submit" className="btn primary" disabled={emailChange.busy}>
          Send confirmation link
        </button>
        <p className="muted small">
          We email a link to the new address; your email changes once you open it. Your old address is told.
        </p>
      </form>

      <section className="panel account-section" aria-labelledby="updates-heading">
        <h2 id="updates-heading">Email updates</h2>
        <label className="check">
          <input type="checkbox" checked={user.priceDropEmails} disabled={updates.busy} onChange={changePriceDrops} />
          Tell me when something on my wishlist gets 5% cheaper or more
        </label>
        <Feedback state={updates} />
        <p className="muted small">Emails about your orders always come.</p>
      </section>

      <form className="panel account-section" onSubmit={submitAddress} aria-labelledby="address-heading">
        <h2 id="address-heading">Saved address</h2>
        <p className="muted small">Checkout fills this in. Placing an order also saves the address you used.</p>
        <AddressFields key={addressVersion} saved={user.address} defaultName={user.name} />
        <Feedback state={address} />
        <div className="account-actions">
          <button type="submit" className="btn primary" disabled={address.busy}>
            Save address
          </button>
          {user.address && (
            <button type="button" className="btn" onClick={removeAddress} disabled={address.busy}>
              Remove
            </button>
          )}
        </div>
      </form>

      <form className="panel account-section" onSubmit={submitPassword} aria-labelledby="password-heading">
        <h2 id="password-heading">Change password</h2>
        <label>
          Current password
          <input name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} />
        </label>
        <label>
          New password
          <input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={128}
          />
          <span className="muted small">At least 8 characters, different from your current one</span>
        </label>
        <label>
          Type the new password again
          <input name="confirm" type="password" autoComplete="new-password" required maxLength={128} />
        </label>
        <Feedback state={password} />
        <button type="submit" className="btn primary" disabled={password.busy}>
          Change password
        </button>
        <p className="muted small">This logs you out on your other devices.</p>
      </form>

      <TwoStepSection />
    </div>
  );
}
