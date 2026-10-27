import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';
import AccountNav from '../components/AccountNav.jsx';
import AddressFields from '../components/AddressFields.jsx';
import TwoStepSection from '../components/TwoStepSection.jsx';
import { MAX_ADDRESSES, addressLine } from '../format.js';
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

// The address book: each saved address with Edit, Make default and Remove, and a form to add one. One form is open
// at a time (`editing`: an address id, 'new' or null); the inputs are uncontrolled, filled from the address.
function AddressBook({ user, setUser }) {
  const [state, save] = useSave();
  const [editing, setEditing] = useState(null);
  const full = user.addresses.length >= MAX_ADDRESSES;

  function submit(e) {
    e.preventDefault();
    const { label, ...address } = Object.fromEntries(new FormData(e.currentTarget));
    const isNew = editing === 'new';
    save(
      async () => {
        const res = await request(isNew ? '/account/addresses' : `/account/addresses/${editing}`, {
          method: isNew ? 'POST' : 'PUT',
          body: { address, label },
        });
        setUser(res.user);
        setEditing(null);
      },
      isNew ? 'Address added' : 'Address saved',
    );
  }
  const act = (path, method, done) => save(async () => setUser((await request(path, { method })).user), done);
  const name = (a) => a.label || a.name;

  const editor = (a) => (
    <form className="address-editor" onSubmit={submit} aria-label={a ? `Edit ${name(a)}` : 'New address'}>
      <label>
        Label (optional)
        <input name="label" maxLength={30} defaultValue={a?.label ?? ''} placeholder="Home, Office…" />
      </label>
      <AddressFields saved={a} defaultName={user.name} />
      <div className="account-actions">
        <button type="submit" className="btn primary" disabled={state.busy}>
          Save address
        </button>
        <button type="button" className="btn" onClick={() => setEditing(null)}>
          Cancel
        </button>
      </div>
    </form>
  );

  return (
    <section className="panel account-section" id="addresses" aria-labelledby="address-heading">
      <h2 id="address-heading">Addresses</h2>
      <p className="muted small">
        Checkout offers these, the default first. A new address you order to is added here unless you untick &ldquo;Save
        it&rdquo;.
      </p>
      {user.addresses.length === 0 && editing !== 'new' && <p className="muted">No saved addresses yet.</p>}
      {user.addresses.length > 0 && (
        <ul className="address-list">
          {user.addresses.map((a, i) => (
            <li key={a.id} className="address-card">
              {editing === a.id ? (
                editor(a)
              ) : (
                <>
                  <p>
                    <strong>{name(a)}</strong>
                    {i === 0 && <span className="status">Default</span>}
                  </p>
                  <p className="muted small">
                    {a.label && `${a.name}, `}
                    {addressLine(a)} · {a.phone}
                  </p>
                  <div className="account-actions">
                    <button
                      type="button"
                      className="btn small"
                      aria-label={`Edit ${name(a)}`}
                      onClick={() => setEditing(a.id)}
                    >
                      Edit
                    </button>
                    {i > 0 && (
                      <button
                        type="button"
                        className="btn small"
                        aria-label={`Make default: ${name(a)}`}
                        disabled={state.busy}
                        onClick={() => act(`/account/addresses/${a.id}/default`, 'POST', 'Default address changed')}
                      >
                        Make default
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn small"
                      aria-label={`Remove ${name(a)}`}
                      disabled={state.busy}
                      onClick={() => act(`/account/addresses/${a.id}`, 'DELETE', 'Address removed')}
                    >
                      Remove
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing === 'new' && editor(null)}
      {editing !== 'new' &&
        (full ? (
          <p className="muted small">
            That&apos;s {MAX_ADDRESSES} addresses, the most kept: remove one to add another.
          </p>
        ) : (
          <button type="button" className="btn" onClick={() => setEditing('new')}>
            Add an address
          </button>
        ))}
      <Feedback state={state} />
    </section>
  );
}

export default function Account() {
  const { user, setUser } = useAuth();
  const [details, saveDetails] = useSave();
  const [password, savePassword] = useSave();
  const [emailChange, saveEmailChange] = useSave();
  const [updates, saveUpdates] = useSave();
  // Bumped to reload the pending email change after asking for one or cancelling it.
  const [emailVersion, setEmailVersion] = useState(0);
  const { data: pending } = useFetch(user ? '/account/email' : null, emailVersion);
  // Links to a section (/account#addresses from checkout, #two-step from the admin panel) scroll to it once the page,
  // loaded on first use, has the user.
  const { hash } = useLocation();
  const ready = Boolean(user);
  useEffect(() => {
    if (ready && hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [ready, hash]);

  if (user === undefined) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to="/login?next=/account" replace />;

  const fields = (e) => Object.fromEntries(new FormData(e.currentTarget));

  function submitDetails(e) {
    e.preventDefault();
    const { name } = fields(e);
    saveDetails(async () => setUser((await request('/account', { method: 'PATCH', body: { name } })).user), 'Saved');
  }

  // Saved as soon as one is ticked or unticked.
  function changeEmails(choice, label) {
    return (e) => {
      const on = e.target.checked;
      saveUpdates(
        async () =>
          setUser((await request('/account/email-preferences', { method: 'PUT', body: { [choice]: on } })).user),
        `${label} ${on ? 'on' : 'off'}.`,
      );
    };
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
          <input
            type="checkbox"
            checked={user.priceDropEmails}
            disabled={updates.busy}
            onChange={changeEmails('priceDropEmails', 'Price-drop emails are')}
          />
          Tell me when something on my wishlist gets 5% cheaper or more
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={user.cartReminderEmails}
            disabled={updates.busy}
            onChange={changeEmails('cartReminderEmails', 'Cart reminders are')}
          />
          Remind me once about things left in my cart for a day
        </label>
        <Feedback state={updates} />
        <p className="muted small">Emails about your orders always come.</p>
      </section>

      <AddressBook user={user} setUser={setUser} />

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
