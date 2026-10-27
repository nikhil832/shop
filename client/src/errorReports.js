// Tells the store a page failed to load or crashed (POST /api/error-reports), so admins see it without waiting for a
// complaint. Fire and forget: `keepalive` lets the report finish if the visitor reloads straight away, and a report
// that can't be sent is dropped. Each problem is sent once per page load.
const sent = new Set();

export function reportError(kind, error, componentStack) {
  const message = String(error?.message || error || 'Unknown error').slice(0, 500);
  if (sent.has(`${kind}:${message}`)) return;
  sent.add(`${kind}:${message}`);
  const body = {
    kind,
    message,
    stack: typeof error?.stack === 'string' ? error.stack.slice(0, 4000) : undefined,
    componentStack: componentStack ? componentStack.slice(0, 4000) : undefined,
    // Never the part after #: reset and email-change links carry their token there.
    path: (window.location.pathname + window.location.search).slice(0, 500),
  };
  fetch('/api/error-reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
}
