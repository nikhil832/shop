// A stand-in for Google's sign-in (stage 151), so tests never reach Google. Its "code" is the identity itself
// (base64url JSON of { sub?, email, name?, email_verified? }), which the token endpoint turns into an ID token for the
// client that asks; `bad` is refused. GET /auth is a small "choose an account" page (an email and a name, Continue or
// Cancel) that sends the browser back to `redirect_uri` with a code or `error=access_denied`, like Google's.
// Run directly for the e2e tests: FAKE_GOOGLE_PORT=4103 node server/test/fake-google.js
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const FAKE_GOOGLE_CLIENT = { clientId: 'fake-client.apps.googleusercontent.com', clientSecret: 'fake-secret' };

export const codeFor = (identity) => Buffer.from(JSON.stringify(identity)).toString('base64url');

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function startFakeGoogle(port = 0) {
  const state = { exchanges: [], next: {} };

  function token(form) {
    const code = form.get('code');
    let identity;
    try {
      identity = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!identity?.email) return null;
    const claims = {
      iss: 'https://accounts.google.com',
      aud: form.get('client_id'),
      sub: identity.sub ?? `google-${identity.email}`,
      email: identity.email,
      email_verified: identity.email_verified ?? true,
      name: identity.name ?? 'Google User',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (identity.expired ? -60 : 3600),
      ...(identity.aud && { aud: identity.aud }),
    };
    return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.fake-signature`;
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/auth') {
      const back = url.searchParams.get('redirect_uri');
      const st = url.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in – Google (stand-in)</title></head>
<body><main><h1>Choose an account</h1>
<form method="get" action="/auth/continue">
<input type="hidden" name="redirect_uri" value="${escape(back)}"><input type="hidden" name="state" value="${escape(st)}">
<label>Email <input name="email" type="email" required></label>
<label>Name <input name="name"></label>
<button type="submit">Continue</button>
<button type="submit" name="cancel" value="1" formnovalidate>Cancel</button>
</form></main></body></html>`);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/auth/continue') {
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('state', url.searchParams.get('state'));
      if (url.searchParams.get('cancel')) back.searchParams.set('error', 'access_denied');
      else {
        back.searchParams.set(
          'code',
          codeFor({ email: url.searchParams.get('email'), name: url.searchParams.get('name') || undefined }),
        );
      }
      res.writeHead(302, { Location: back.toString() });
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        state.exchanges.push(Object.fromEntries(form));
        const idToken = form.get('code') === 'bad' ? null : token(form);
        res.writeHead(idToken ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(idToken ? { id_token: idToken, access_token: 'fake' } : { error: 'invalid_grant' }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(port, resolve));
  const url = `http://localhost:${server.address().port}`;
  return {
    url,
    state,
    config: (redirectUri) => ({
      ...FAKE_GOOGLE_CLIENT,
      redirectUri,
      authUrl: `${url}/auth`,
      tokenUrl: `${url}/token`,
    }),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url } = await startFakeGoogle(Number(process.env.FAKE_GOOGLE_PORT) || 4103);
  console.log(`Fake Google on ${url}`);
}
