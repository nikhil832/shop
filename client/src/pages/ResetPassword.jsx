import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';

// Opened from the reset email: /reset-password#token=… (after #, so the token never reaches server logs).
export default function ResetPassword() {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const token = new URLSearchParams(useLocation().hash.slice(1)).get('token');
  const [state, setState] = useState({ busy: false, error: null });

  async function submit(e) {
    e.preventDefault();
    const { password, confirm } = Object.fromEntries(new FormData(e.currentTarget));
    if (password !== confirm) return setState({ busy: false, error: "The two passwords don't match" });
    setState({ busy: true, error: null });
    try {
      const res = await request('/auth/reset-password', { method: 'POST', body: { token, password } });
      setUser(res.user);
      // Replaces this entry, so the used link isn't left in the browser history.
      navigate('/', { replace: true });
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  if (!token) {
    return (
      <div className="auth-page">
        <div className="panel auth-form">
          <h1>Reset your password</h1>
          <p>This page needs the link from your reset email. Open the link again, or ask for a new one.</p>
          <Link to="/forgot-password" className="btn primary">
            Get a new link
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="panel auth-form" onSubmit={submit}>
        <h1>Choose a new password</h1>
        <label>
          New password
          <input name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} />
          <span className="muted small">At least 8 characters</span>
        </label>
        <label>
          Type it again
          <input name="confirm" type="password" autoComplete="new-password" required maxLength={128} />
        </label>
        {state.error && (
          <p className="error" role="alert">
            {state.error}
            {/expired|already used/.test(state.error) && (
              <>
                {' '}
                <Link to="/forgot-password">Get a new link</Link>
              </>
            )}
          </p>
        )}
        <button type="submit" className="btn primary" disabled={state.busy}>
          Save and log in
        </button>
        <p className="muted small">This logs you out on your other devices.</p>
      </form>
    </div>
  );
}
