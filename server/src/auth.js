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
const LOCK_MINUTES = 15;
const LOCKED = `Too many wrong passwords for this email. Try again in ${LOCK_MINUTES} minutes, or reset your password.`;

// Compared against when the email is unknown, so both cases take about as long.
const DUMMY_HASH = await hashPassword('not-a-real-password');

// Keyed by a hash of the email (known or not, so a lock says nothing about whether the account exists).
const attemptKey = (email) => hashToken(`login:${email}`);

export const clearPasswordAttempts = (db, email) =>
  db.collection('loginAttempts').deleteMany({ key: attemptKey(email) });

// Checks a password for `email` against `passwordHash` (undefined for an unknown email) under the lock: logging in and
// changing the password share it. Returns true or false; throws 429 while locked, including on the attempt that locks.
// Every attempt is recorded before the check, so many guesses sent at once still count; a right password clears them.
export async function checkPassword(db, email, password, passwordHash) {
  const attempts = db.collection('loginAttempts');
  const key = attemptKey(email);
  const now = Date.now();
  const { insertedId } = await attempts.insertOne({
    key,
    at: new Date(now),
    expiresAt: new Date(now + LOCK_MINUTES * 60_000),
  });
  const tries = await attempts.countDocuments({ key, at: { $gt: new Date(now - LOCK_MINUTES * 60_000) } });
  if (tries > MAX_FAILED_PASSWORDS) {
    // Not kept, so retrying while locked doesn't stretch the lock: it ends LOCK_MINUTES after the last real try.
    await attempts.deleteOne({ _id: insertedId });
    throw new HttpError(429, LOCKED);
  }
  const ok = await verifyPassword(password, passwordHash ?? DUMMY_HASH);
  if (ok && passwordHash) {
    await attempts.deleteMany({ key });
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
