import { useState } from 'react';
import { Link } from 'react-router';
import { request } from '../api.js';

// Asks for a reset link. The server answers the same whether or not the account exists, and so does this page.
export default function ForgotPassword() {
  const [state, setState] = useState({ busy: false, error: null, sentTo: null });

  async function submit(e) {
    e.preventDefault();
    const { email } = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null, sentTo: null });
    try {
      await request('/auth/forgot-password', { method: 'POST', body: { email } });
      setState({ busy: false, error: null, sentTo: email });
    } catch (err) {
      setState({ busy: false, error: err.message, sentTo: null });
    }
  }

  if (state.sentTo) {
    return (
      <div className="auth-page">
        <div className="panel auth-form" role="status">
          <h1>Check your email</h1>
          <p>
            If there's an account for <strong>{state.sentTo}</strong>, we've sent it a link to choose a new password.
            The link works for 1 hour.
          </p>
          <p className="muted small">Nothing there? Check your spam folder, or try again in a few minutes.</p>
          <Link to="/login" className="btn">
            Back to log in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="panel auth-form" onSubmit={submit}>
        <h1>Forgot your password?</h1>
        <p className="muted small">Enter your account's email and we'll send you a link to choose a new one.</p>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required maxLength={254} />
        </label>
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        <button type="submit" className="btn primary" disabled={state.busy}>
          Send reset link
        </button>
        <p className="muted small">
          Remembered it? <Link to="/login">Log in</Link>
        </p>
      </form>
    </div>
  );
}
