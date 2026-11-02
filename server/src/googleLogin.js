import { randomBytes } from 'node:crypto';

// "Continue with Google" (stage 151): OpenID Connect's authorization code flow over plain fetch (no SDK), with
// config.google { clientId, clientSecret, redirectUri, authUrl?, tokenUrl? } (config.js; null without keys).
//
// GET /auth/google sends the visitor to Google with a random `state`, kept with where to go next (and a referral code)
// in a short-lived httpOnly cookie. Google sends them back to /auth/google/callback with a code, which the server swaps
// for an ID token at Google's token endpoint, using the client secret. The ID token comes straight from Google over
// HTTPS in that exchange, so its signature needn't be checked (OpenID Connect Core 3.1.3.7); its issuer, audience,
// expiry and a verified email are. Accounts are found by `users.googleId` (Google's `sub`), else by email (and linked),
// else made without a password, like checkout's quick accounts. Problems send the visitor back to the login page with
// `#google-error=<GOOGLE_ERRORS key>`; two-step accounts with `#google-ticket=…` for their code.

export const GOOGLE_COOKIE = 'bazaar_google';
const COOKIE_MINUTES = 10;
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
// What the login page says for each problem (client/src/pages/Login.jsx has the same keys).
export const GOOGLE_ERRORS = ['cancelled', 'expired', 'failed', 'unverified', 'other-google', 'busy'];

// Where to go after logging in: a path on this site only (never `//host` or a backslash trick).
export const safeNext = (next) =>
  typeof next === 'string' && /^\/(?![/\\])[^\s\\]*$/.test(next) && next.length <= 500 ? next : '/';

// The redirect to Google and the cookie that remembers it: { url, cookie }.
export function startGoogleLogin(google, { next, ref }) {
  const state = randomBytes(24).toString('base64url');
  const params = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: google.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  const cookie = JSON.stringify({ state, next: safeNext(next), ref: typeof ref === 'string' ? ref.slice(0, 20) : '' });
  return { url: `${google.authUrl ?? AUTH_URL}?${params}`, cookie, maxAge: COOKIE_MINUTES * 60_000 };
}

// The cookie's { state, next, ref }, or null.
export function readGoogleCookie(value) {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed?.state === 'string' ? { ...parsed, next: safeNext(parsed.next) } : null;
  } catch {
    return null;
  }
}

// Swaps the code for Google's ID token and checks it: { sub, email, name } or throws Error with `code` (a
// GOOGLE_ERRORS key). Never includes the client secret in what it throws.
export async function googleIdentity(google, code, now = Date.now()) {
  let res;
  try {
    res = await fetch(google.tokenUrl ?? TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: google.clientId,
        client_secret: google.clientSecret,
        redirect_uri: google.redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw Object.assign(new Error(`Google couldn't be reached (${err.name})`), { code: 'failed' });
  }
  if (!res.ok) throw Object.assign(new Error(`Google refused the code (${res.status})`), { code: 'failed' });
  const { id_token: idToken } = await res.json().catch(() => ({}));
  const claims = decodeJwt(idToken);
  if (
    !claims ||
    !ISSUERS.includes(claims.iss) ||
    claims.aud !== google.clientId ||
    typeof claims.exp !== 'number' ||
    claims.exp * 1000 <= now ||
    typeof claims.sub !== 'string' ||
    !claims.sub
  ) {
    throw Object.assign(new Error('Google sent an ID token that does not check out'), { code: 'failed' });
  }
  if (typeof claims.email !== 'string' || claims.email_verified !== true) {
    throw Object.assign(new Error('The Google account has no verified email'), { code: 'unverified' });
  }
  const email = claims.email.trim().toLowerCase();
  const name = (typeof claims.name === 'string' && claims.name.trim().slice(0, 80)) || email.split('@')[0];
  return { sub: claims.sub, email, name };
}

// The payload of a JWT (not its signature: see above), or null.
function decodeJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// The account for this Google identity: by googleId, else by email (linking it), else a new one. Returns the user.
export async function userForGoogle(db, identity, { referredBy = null } = {}) {
  const users = db.collection('users');
  const bySub = await users.findOne({ googleId: identity.sub });
  if (bySub) return bySub;
  // Linked only if no other Google account is, so one account can't be taken over by a second Google account.
  const linked = await users.findOneAndUpdate(
    { email: identity.email, googleId: { $exists: false } },
    { $set: { googleId: identity.sub } },
    { returnDocument: 'after' },
  );
  if (linked) return linked;
  if (await users.findOne({ email: identity.email }, { projection: { _id: 1 } })) {
    throw Object.assign(new Error('That email is linked to another Google account'), { code: 'other-google' });
  }
  const doc = {
    name: identity.name,
    email: identity.email,
    passwordHash: null,
    role: 'user',
    googleId: identity.sub,
    createdAt: new Date(),
    ...(referredBy && { referredBy }),
  };
  try {
    const { insertedId } = await users.insertOne(doc);
    return { ...doc, _id: insertedId };
  } catch (err) {
    // The same person finishing twice at once: the other request made the account.
    if (err.code === 11000) {
      const made = await users.findOne({ googleId: identity.sub });
      if (made) return made;
    }
    throw err;
  }
}
