import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { request } from '../api.js';

// /unsubscribe#token=… (stage 140), from the link in store news emails. It takes a click, not a page load, so a mail
// scanner opening the link unsubscribes nobody (mail apps' own one-click button posts to the API directly).
export default function Unsubscribe() {
  const token = new URLSearchParams(useLocation().hash.slice(1)).get('token') ?? '';
  const [state, setState] = useState({ busy: false, error: null, done: false });

  async function unsubscribe() {
    setState({ busy: true, error: null, done: false });
    try {
      await request(`/news/unsubscribe?token=${encodeURIComponent(token)}`, { method: 'POST' });
      setState({ busy: false, error: null, done: true });
    } catch (err) {
      setState({ busy: false, error: err.message, done: false });
    }
  }

  return (
    <div className="auth-page">
      <div className="panel auth-form">
        <h1>Store news emails</h1>
        {state.done ? (
          <p role="status">
            You&apos;re unsubscribed. We won&apos;t send you store news again. Emails about your orders still come.
          </p>
        ) : (
          <>
            <p>Stop getting emails about new arrivals and sales? Emails about your orders still come.</p>
            {state.error && (
              <p className="error" role="alert">
                {state.error}
              </p>
            )}
            <button type="button" className="btn primary" onClick={unsubscribe} disabled={state.busy || !token}>
              Unsubscribe from store news
            </button>
          </>
        )}
        <p className="muted small">
          You can switch store news on or off any time on <Link to="/account#updates">your account page</Link>.
        </p>
      </div>
    </div>
  );
}
