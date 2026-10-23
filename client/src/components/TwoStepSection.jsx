import { useState } from 'react';
import QRCode from 'qrcode';
import { request } from '../api.js';
import { useAuth } from '../auth.jsx';

// Shows one-time recovery codes once, to be saved before moving on.
function RecoveryCodes({ codes, onDone }) {
  const text = `Bazaar recovery codes (each works once):\n${codes.join('\n')}\n`;
  return (
    <div className="recovery-codes" role="status">
      <p>
        <strong>Save these recovery codes</strong> somewhere safe (a password manager, or printed). Each logs you in
        once if you lose your phone. They won&rsquo;t be shown again.
      </p>
      <ul>
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ul>
      <div className="account-actions">
        <a
          className="btn"
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}
          download="bazaar-recovery-codes.txt"
        >
          Download as a file
        </a>
        <button type="button" className="btn primary" onClick={onDone}>
          I've saved them
        </button>
      </div>
    </div>
  );
}

// The account page's two-step login: turn it on (password → scan or type the key → confirm with a code → recovery
// codes), get new recovery codes, or turn it off (password and a code).
export default function TwoStepSection() {
  const { user, setUser } = useAuth();
  // setup: { secret, qr } while setting up; codes: recovery codes to show once.
  const [setup, setSetup] = useState(null);
  const [codes, setCodes] = useState(null);
  const [mode, setMode] = useState(null); // 'off' | 'codes' while those forms are open
  const [state, setState] = useState({ busy: false, error: null });

  async function run(action) {
    setState({ busy: true, error: null });
    try {
      await action();
      setState({ busy: false, error: null });
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }
  const fields = (e) => Object.fromEntries(new FormData(e.currentTarget));

  function start(e) {
    e.preventDefault();
    const { password } = fields(e);
    run(async () => {
      const res = await request('/account/two-step/setup', { method: 'POST', body: { password } });
      const qr = await QRCode.toDataURL(res.uri, { margin: 1, width: 220 });
      setSetup({ secret: res.secret, qr });
    });
  }
  function confirm(e) {
    e.preventDefault();
    const { code } = fields(e);
    run(async () => {
      const res = await request('/account/two-step/enable', { method: 'POST', body: { code } });
      setSetup(null);
      setCodes(res.recoveryCodes);
      setUser(res.user);
    });
  }
  function newCodes(e) {
    e.preventDefault();
    const { code } = fields(e);
    run(async () => {
      const res = await request('/account/two-step/recovery-codes', { method: 'POST', body: { code } });
      setMode(null);
      setCodes(res.recoveryCodes);
    });
  }
  function turnOff(e) {
    e.preventDefault();
    const body = fields(e);
    run(async () => {
      const res = await request('/account/two-step/disable', { method: 'POST', body });
      setMode(null);
      setUser(res.user);
    });
  }

  const error = state.error && (
    <p className="error" role="alert">
      {state.error}
    </p>
  );
  // The setup key in groups of four, easier to type into an app.
  const grouped = setup?.secret.match(/.{1,4}/g).join(' ');

  return (
    <section className="panel account-section" id="two-step" aria-labelledby="two-step-heading">
      <h2 id="two-step-heading">Two-step login</h2>
      {codes ? (
        <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
      ) : user.twoStep ? (
        <>
          <p>
            <strong>On.</strong> Logging in takes your password and a code from your authenticator app.
          </p>
          {mode === 'codes' && (
            <form className="account-subform" onSubmit={newCodes}>
              <label>
                Code from your app
                <input name="code" autoComplete="one-time-code" inputMode="numeric" required maxLength={6} />
              </label>
              {error}
              <button type="submit" className="btn primary" disabled={state.busy}>
                Make new recovery codes
              </button>
            </form>
          )}
          {mode === 'off' && (
            <form className="account-subform" onSubmit={turnOff}>
              <label>
                Your password
                <input name="password" type="password" autoComplete="current-password" required maxLength={128} />
              </label>
              <label>
                Code from your app (or a recovery code)
                <input name="code" autoComplete="one-time-code" required maxLength={20} />
              </label>
              {error}
              <button type="submit" className="btn" disabled={state.busy}>
                Turn off two-step login
              </button>
            </form>
          )}
          {!mode && (
            <div className="account-actions">
              <button type="button" className="btn" onClick={() => setMode('codes')}>
                New recovery codes
              </button>
              <button type="button" className="btn" onClick={() => setMode('off')}>
                Turn off
              </button>
            </div>
          )}
        </>
      ) : setup ? (
        <form className="account-subform" onSubmit={confirm}>
          <p>
            1. In an authenticator app (Google Authenticator, Microsoft Authenticator, Authy…), add an account by
            scanning this code:
          </p>
          <img
            src={setup.qr}
            alt="QR code for your authenticator app"
            width="220"
            height="220"
            className="two-step-qr"
          />
          <p className="small">
            Or type this setup key: <code className="setup-key">{grouped}</code>
          </p>
          <label>
            2. Enter the 6-digit code the app shows
            <input name="code" autoComplete="one-time-code" inputMode="numeric" required maxLength={6} />
          </label>
          {error}
          <div className="account-actions">
            <button type="submit" className="btn primary" disabled={state.busy}>
              Turn on
            </button>
            <button type="button" className="btn" onClick={() => setSetup(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <form className="account-subform" onSubmit={start}>
          <p className="muted small">
            With two-step login, someone who learns your password still can&rsquo;t log in without the code from your
            phone. You&rsquo;ll need an authenticator app (free).
          </p>
          <label>
            Your password
            <input name="password" type="password" autoComplete="current-password" required maxLength={128} />
          </label>
          {error}
          <button type="submit" className="btn primary" disabled={state.busy}>
            Set up two-step login
          </button>
        </form>
      )}
    </section>
  );
}
