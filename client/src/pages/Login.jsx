import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { request } from '../api.js';
import { safeNext, useAuth } from '../auth.jsx';

// One form for both logging in and creating an account. `?next=` says where to go afterwards.
export default function Login({ mode = 'login' }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [state, setState] = useState({ busy: false, error: null });
  // Two-step login: the ticket the password earned, while the code is asked for.
  const [ticket, setTicket] = useState(null);
  const notice = useLocation().state?.notice;
  const next = safeNext(params.get('next'));
  const register = mode === 'register';

  if (user) return <Navigate to={next} replace />;

  async function submit(e) {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null });
    try {
      const res = await request(register ? '/auth/register' : '/auth/login', { method: 'POST', body });
      if (res.twoStep) {
        setTicket(res.ticket);
        return setState({ busy: false, error: null });
      }
      setUser(res.user);
      navigate(next, { replace: true });
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  async function submitCode(e) {
    e.preventDefault();
    const { code } = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null });
    try {
      const res = await request('/auth/login/code', { method: 'POST', body: { ticket, code } });
      setUser(res.user);
      navigate(next, { replace: true });
    } catch (err) {
      // An expired or used-up ticket: back to the password.
      if (err.status === 400 || err.status === 429) setTicket(null);
      setState({ busy: false, error: err.message });
    }
  }

  if (ticket) {
    return (
      <div className="auth-page">
        <form className="panel auth-form" onSubmit={submitCode}>
          <h1>Two-step login</h1>
          <p>Enter the 6-digit code from your authenticator app.</p>
          <label>
            Code
            <input
              name="code"
              autoComplete="one-time-code"
              inputMode="text"
              required
              maxLength={20}
              autoFocus
              placeholder="123456"
            />
            <span className="muted small">Lost your phone? Enter one of your recovery codes instead.</span>
          </label>
          {state.error && (
            <p className="error" role="alert">
              {state.error}
            </p>
          )}
          <button type="submit" className="btn primary" disabled={state.busy}>
            Log in
          </button>
          <button type="button" className="link" onClick={() => setTicket(null)}>
            Back
          </button>
        </form>
      </div>
    );
  }

  const other = `${register ? '/login' : '/register'}${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`;

  return (
    <div className="auth-page">
      <form className="panel auth-form" onSubmit={submit}>
        <h1>{register ? 'Create your account' : 'Log in'}</h1>
        {notice && !register && <p role="status">{notice}</p>}
        {register && (
          <label>
            Name
            <input name="name" autoComplete="name" required maxLength={80} />
          </label>
        )}
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required maxLength={254} />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete={register ? 'new-password' : 'current-password'}
            required
            minLength={register ? 8 : undefined}
            maxLength={128}
          />
          {register && <span className="muted small">At least 8 characters</span>}
        </label>
        {!register && (
          <p className="small">
            <Link to="/forgot-password">Forgot password?</Link>
          </p>
        )}
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        <button type="submit" className="btn primary" disabled={state.busy}>
          {register ? 'Create account' : 'Log in'}
        </button>
        <p className="muted small">
          {register ? 'Already have an account? ' : 'New to Bazaar? '}
          <Link to={other}>{register ? 'Log in' : 'Create an account'}</Link>
        </p>
      </form>
    </div>
  );
}
