import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';

// Opened from the email sent to a new address: /confirm-email#token=… (after #, so the token never reaches server
// logs). Confirming takes a click rather than happening on load, so a mail scanner opening the link changes nothing.
export default function ConfirmEmail() {
  const { user, setUser } = useAuth();
  const token = new URLSearchParams(useLocation().hash.slice(1)).get('token');
  const [state, setState] = useState({ busy: false, error: null, email: null });

  async function confirm() {
    setState({ busy: true, error: null, email: null });
    try {
      const res = await request('/auth/confirm-email', { method: 'POST', body: { token } });
      if (res.user) setUser(res.user);
      setState({ busy: false, error: null, email: res.email });
      // The used link isn't left in the address bar or history.
      window.history.replaceState(null, '', '/confirm-email');
    } catch (err) {
      setState({ busy: false, error: err.message, email: null });
    }
  }

  if (state.email) {
    return (
      <div className="auth-page">
        <div className="panel auth-form">
          <h1>Email changed</h1>
          <p role="status">
            Your account now uses <strong>{state.email}</strong>. Log in with it from now on.
          </p>
          <Link to={user ? '/account' : '/login'} className="btn primary">
            {user ? 'Back to your account' : 'Log in'}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="panel auth-form">
        <h1>Confirm your new email</h1>
        {!token ? (
          <p>This page needs the link from the confirmation email. Open the link again, or ask for a new one.</p>
        ) : (
          <>
            <p>Confirm that this address should be the email for your Bazaar account.</p>
            <button type="button" className="btn primary" onClick={confirm} disabled={state.busy}>
              Confirm new email
            </button>
          </>
        )}
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        <Link to="/account">Your account</Link>
      </div>
    </div>
  );
}
