import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { request } from '../api.js';
import { safeNext, useAuth } from '../auth.jsx';
import { referralCode } from '../referral.js';

// One form for both logging in and creating an account. `?next=` says where to go afterwards.
export default function Login({ mode = 'login' }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [state, setState] = useState({ busy: false, error: null });
  // Two-step login: the ticket the password earned, while the code is asked for.
  const [ticket, setTicket] = useState(null);
  // Logging in with an emailed code (stage 110): null, or { email, sent } while asking for and entering it.
  const [emailCode, setEmailCode] = useState(null);
  const notice = useLocation().state?.notice;
  const next = safeNext(params.get('next'));
  const register = mode === 'register';

  if (user) return <Navigate to={next} replace />;

  async function submit(e) {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null });
    try {
      // A friend's referral code from this browser (stage 87) goes with a new account.
      const ref = register ? referralCode() : null;
      const res = await request(register ? '/auth/register' : '/auth/login', {
        method: 'POST',
        body: { ...body, ...(ref && { ref }) },
      });
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

  // Sends a code to the email (the answer is the same whether or not it has an account).
  async function sendCode(email) {
    setState({ busy: true, error: null });
    try {
      await request('/auth/email-code', { method: 'POST', body: { email } });
      setEmailCode({ email, sent: true });
      setState({ busy: false, error: null });
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }
  async function submitEmailCode(e) {
    e.preventDefault();
    const { email, code } = Object.fromEntries(new FormData(e.currentTarget));
    if (!emailCode?.sent) return sendCode(email);
    setState({ busy: true, error: null });
    try {
      const res = await request('/auth/email-code/login', { method: 'POST', body: { email: emailCode.email, code } });
      if (res.twoStep) {
        setEmailCode(null);
        setTicket(res.ticket);
        return setState({ busy: false, error: null });
      }
      setUser(res.user);
      navigate(next, { replace: true });
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  if (emailCode && !ticket) {
    return (
      <div className="auth-page">
        <form className="panel auth-form" onSubmit={submitEmailCode} aria-labelledby="email-code-heading">
          <h1 id="email-code-heading">Log in with an email code</h1>
          {emailCode.sent ? (
            <>
              <p role="status">
                If <strong>{emailCode.email}</strong> has an account, we&apos;ve emailed it a 6-digit code. It works for
                10 minutes.
              </p>
              <label>
                Code
                <input
                  name="code"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  required
                  maxLength={6}
                  autoFocus
                  placeholder="123456"
                />
              </label>
            </>
          ) : (
            <label>
              Email
              <input name="email" type="email" autoComplete="email" required maxLength={254} autoFocus />
            </label>
          )}
          {state.error && (
            <p className="error" role="alert">
              {state.error}
            </p>
          )}
          <button type="submit" className="btn primary" disabled={state.busy}>
            {emailCode.sent ? 'Log in' : 'Email me a code'}
          </button>
          {emailCode.sent && (
            <button type="button" className="link" onClick={() => sendCode(emailCode.email)} disabled={state.busy}>
              Send a new code
            </button>
          )}
          <button type="button" className="link" onClick={() => setEmailCode(null)}>
            Use my password instead
          </button>
        </form>
      </div>
    );
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
          <p className="small login-alternatives">
            <Link to="/forgot-password">Forgot password?</Link>
            <button type="button" className="link" onClick={() => setEmailCode({ email: '', sent: false })}>
              Use an email code instead
            </button>
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
