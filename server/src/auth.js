import { isIP, isIPv4, isIPv6 } from 'node:net';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './http.js';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

export const SESSION_COOKIE = 'sid';
export const SESSION_DAYS = 30;

// Stored as "scrypt$<salt>$<hash>" (base64), so the parameters can change later without breaking old hashes.
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

// Only a hash of the token is stored, so a leaked sessions (or passwordResets) collection can't be used to log in.
export const hashToken = (token) => createHash('sha256').update(token).digest('base64url');

export async function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  await db.collection('sessions').insertOne({
    tokenHash: hashToken(token),
    userId,
    createdAt: new Date(now),
    expiresAt: new Date(now + SESSION_DAYS * 86_400_000),
  });
  return token;
}

export async function deleteSession(db, token) {
  if (token) await db.collection('sessions').deleteOne({ tokenHash: hashToken(token) });
}

export function readSessionCookie(req) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(value.join('='));
  }
  return null;
}

export const sessionCookieOptions = (req) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: req.secure,
  path: '/',
});

// Sets req.user (or null) from the session cookie. Expired sessions are ignored (and removed by a TTL index).
export function sessionMiddleware({ db }) {
  return async (req, res, next) => {
    req.user = null;
    const token = readSessionCookie(req);
    if (token) {
      const session = await db
        .collection('sessions')
        .findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } });
      if (session) req.user = await db.collection('users').findOne({ _id: session.userId });
    }
    next();
  };
}

export function requireUser(req, res, next) {
  if (!req.user) throw new HttpError(401, 'Please log in');
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) throw new HttpError(401, 'Please log in');
  if (req.user.role !== 'admin') throw new HttpError(403, 'Admins only');
  next();
}

// Wrong passwords allowed per email within LOCK_MINUTES; after that, checks for that email are refused (even the
// right password, so a guesser learns nothing) until the attempts age out or the password is reset.
const MAX_FAILED_PASSWORDS = 5;
// Wrong passwords allowed from one network (IPv4 address or IPv6 /64) within LOCK_MINUTES, across all emails: stops one
// person trying a common password on many accounts. Generous, because mobile networks put many people behind one address.
const MAX_FAILED_PER_NETWORK = 20;
const LOCK_MINUTES = 15;
const LOCKED = `Too many wrong passwords for this email. Try again in ${LOCK_MINUTES} minutes, or reset your password.`;
const NETWORK_LOCKED = `Too many wrong passwords from your network. Try again in ${LOCK_MINUTES} minutes.`;

// Compared against when the email is unknown, so both cases take about as long.
const DUMMY_HASH = await hashPassword('not-a-real-password');

// Keyed by a hash of the email (known or not, so a lock says nothing about whether the account exists), or of the
// network, so addresses aren't stored as they are.
const attemptKey = (email) => hashToken(`login:${email}`);
const networkKey = (network) => hashToken(`network:${network}`);

// The visitor's network: an IPv4 address, or the /64 an IPv6 address is in (one home or phone usually gets a whole /64).
export function networkOf(ip) {
  if (!ip) return 'unknown';
  const v4 = ip.replace(/^::ffff:/i, '');
  if (isIPv4(v4)) return v4;
  if (!isIPv6(ip)) return 'unknown';
  const [head, tail] = ip.split('::');
  const before = head ? head.split(':') : [];
  const after = tail ? tail.split(':') : [];
  const groups = [...before, ...Array(8 - before.length - after.length).fill('0'), ...after];
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

// The visitor's IP. Behind Render, req.ip is Render's own load balancer, and X-Forwarded-For starts with whatever the
// visitor sent; CLIENT_IP_HEADER names the header the host's edge sets itself (cf-connecting-ip on Render, checked with
// GET /api/admin/request-info). Without it, req.ip (locally, the real address).
export function clientIp(req, config) {
  const header = config.clientIpHeader && req.get(config.clientIpHeader)?.trim();
  return header && isIP(header) ? header : req.ip;
}

export const clearPasswordAttempts = (db, email) =>
  db.collection('loginAttempts').deleteMany({ key: attemptKey(email) });

// Checks a password for `email` against `passwordHash` (undefined for an unknown email) under two locks: per email and
// per `network` (networkOf(clientIp(req))). Logging in and changing the password share them. Returns true or false;
// throws 429 while locked, including on the attempt that locks the email. Every attempt is recorded before the check,
// so many guesses sent at once still count. A right password clears the email's attempts but not the network's, or
// an attacker could reset the network count by logging in to an account of their own between guesses.
export async function checkPassword(db, email, password, passwordHash, network = 'unknown') {
  const attempts = db.collection('loginAttempts');
  const key = attemptKey(email);
  const netKey = networkKey(network);
  const now = Date.now();
  const expiresAt = new Date(now + LOCK_MINUTES * 60_000);
  const { insertedIds } = await attempts.insertMany([
    { key, at: new Date(now), expiresAt },
    { key: netKey, at: new Date(now), expiresAt },
  ]);
  const ours = { _id: { $in: Object.values(insertedIds) } };
  const since = { $gt: new Date(now - LOCK_MINUTES * 60_000) };
  const [tries, networkTries] = await Promise.all([
    attempts.countDocuments({ key, at: since }),
    attempts.countDocuments({ key: netKey, at: since }),
  ]);
  // Refused attempts are not kept, so retrying while locked doesn't stretch a lock: it ends LOCK_MINUTES after the
  // last real try.
  if (networkTries > MAX_FAILED_PER_NETWORK) {
    await attempts.deleteMany(ours);
    throw new HttpError(429, NETWORK_LOCKED);
  }
  if (tries > MAX_FAILED_PASSWORDS) {
    await attempts.deleteMany(ours);
    throw new HttpError(429, LOCKED);
  }
  const ok = await verifyPassword(password, passwordHash ?? DUMMY_HASH);
  if (ok && passwordHash) {
    await Promise.all([attempts.deleteMany({ key }), attempts.deleteOne({ _id: insertedIds[1] })]);
    return true;
  }
  // The last allowed wrong password already says the email is locked.
  if (tries === MAX_FAILED_PASSWORDS) throw new HttpError(429, LOCKED);
  return false;
}

export const toUser = (doc) => ({
  id: doc._id.toString(),
  name: doc.name,
  email: doc.email,
  role: doc.role,
  address: doc.address ?? null,
});
