import { useState } from 'react';
import { request } from '../api.js';

const REASONS = {
  abuse: 'Abuse',
  spam: 'Spam',
  personal_details: 'Personal details',
  other: 'Worth a look',
};

// Shown on a review or question that screening flagged (stage 61) and no admin has dealt with: why, Claude's note,
// and "Looks fine" to clear it. Hiding the post is the other way to deal with it. Nothing for posts that weren't flagged.
export default function ScreeningFlag({ kind, post, onChange }) {
  const [state, setState] = useState({ busy: false, error: null });
  const s = post.screening;
  if (!s?.flagged || s.cleared || post.hidden) return null;

  async function clear() {
    setState({ busy: true, error: null });
    try {
      await request(`/admin/screening/${kind}/${post.id}/clear`, { method: 'POST' });
      onChange();
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <div className="screening-flag">
      <p>
        <strong>Flagged: {s.reasons.map((r) => REASONS[r] ?? r).join(', ')}</strong>
        {s.note && <span className="block small">{s.note}</span>}
      </p>
      <button type="button" className="link" onClick={clear} disabled={state.busy}>
        Looks fine<span className="sr-only"> (clear the flag)</span>
      </button>
      {state.error && (
        <p className="error small" role="alert">
          {state.error}
        </p>
      )}
    </div>
  );
}
