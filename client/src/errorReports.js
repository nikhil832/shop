// Tells the store a page failed to load, crashed or was blocked from loading something (POST /api/error-reports), so admins see it without waiting for a
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

// Something the security policy (server/src/securityHeaders.js) stopped the page from loading, most likely a new
// address Razorpay's payment window needs. Only the address's origin is sent, never its path or query. Browser
// extensions trip the policy too; those aren't the store's problem and aren't sent.
const EXTENSION = /^(chrome|moz|safari-web|ms-browser)-extension:/;
function originOnly(uri) {
  try {
    return new URL(uri).origin;
  } catch {
    return uri; // "inline", "eval", "data" and the like
  }
}

export function watchSecurityPolicy() {
  document.addEventListener('securitypolicyviolation', (e) => {
    if (EXTENSION.test(e.blockedURI) || EXTENSION.test(e.sourceFile)) return;
    const directive = e.effectiveDirective || e.violatedDirective;
    reportError('blocked', `Blocked by ${directive}: ${originOnly(e.blockedURI) || 'unknown'}`);
  });
}
