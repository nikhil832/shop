import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { request } from '../api.js';
import { safeNext, useAuth } from '../auth.jsx';
import { referralCode } from '../referral.js';
import { useFetch } from '../useFetch.js';

// Why "Continue with Google" (stage 151) came back without logging in: the server's #google-error=<key>.
const GOOGLE_ERRORS = {
  cancelled: 'Logging in with Google was cancelled.',
  expired: 'That took too long or started in another browser. Please try again.',
  failed: "We couldn't log you in with Google. Please try again.",
  unverified: 'Your Google account has no verified email address.',
  'other-google': 'This email is linked to a different Google account. Log in with your password instead.',
  busy: 'Too many logins from here just now. Please try again later.',
};

// "Continue with Google": a plain link, as the server sends the browser on to Google.
function GoogleButton({ next }) {
  const { data } = useFetch('/auth/options');
  if (!data?.google) return null;
  const ref = referralCode();
  const query = new URLSearchParams({ ...(next !== '/' && { next }), ...(ref && { ref }) }).toString();
  return (
    <>
      <p className="or-divider" aria-hidden="true">
        <span>or</span>
      </p>
      <a className="btn google-button" href={`/api/auth/google${query ? `?${query}` : ''}`}>
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
          <path
            fill="#EA4335"
            d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.8 6C12.4 13.6 17.7 9.5 24 9.5z"
          />
          <path
            fill="#4285F4"
            d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 7.1-10 7.1-17.5z"
          />
          <path
            fill="#FBBC05"
            d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.3.8-4.7l-7.8-6C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.8-6z"
          />
          <path
            fill="#34A853"
            d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.8 6C6.6 42.6 14.6 48 24 48z"
          />
        </svg>
        Continue with Google
      </a>
    </>
  );
}

// One form for both logging in and creating an account. `?next=` says where to go afterwards.
export default function Login({ mode = 'login' }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [state, setState] = useState({ busy: false, error: null });
  // Two-step login: the ticket the password earned, while the code is asked for.
  // Two-step accounts back from Google (stage 151) arrive with their ticket after the #.
  const location = useLocation();
  const hash = new URLSearchParams(location.hash.slice(1));
  const [ticket, setTicket] = useState(() => hash.get('google-ticket'));
  const googleError = GOOGLE_ERRORS[hash.get('google-error')] ?? null;
  // Logging in with an emailed code (stage 110): null, or { email, sent } while asking for and entering it.
  const [emailCode, setEmailCode] = useState(null);
  const notice = location.state?.notice;
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
        {googleError && (
          <p className="error" role="alert">
            {googleError}
          </p>
        )}
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
        <GoogleButton next={next} />
      </form>
    </div>
  );
}
