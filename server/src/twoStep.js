import { randomBytes } from 'node:crypto';
import { hashToken } from './auth.js';
import { normalizeRecoveryCode, verifyCode } from './totp.js';

// Two-step login: an account with `totp` (set up from the account page) needs, after its password, a code from an
// authenticator app or one of its one-time recovery codes. Between the two, the browser holds a login ticket
// (`loginChallenges`: a hash of a random token, 5 minutes, at most MAX_WRONG_CODES wrong codes).
export const TICKET_MINUTES = 5;
export const MAX_WRONG_CODES = 5;

export const hasTwoStep = (user) => Boolean(user?.totp?.enabledAt);

// Checks a code for `user`: a 6-digit app code (each used once: the step is recorded in the same update that accepts
// it), or a recovery code (removed as it is used). Returns 'app', 'recovery' or null.
export async function checkSecondStep(db, user, code) {
  const users = db.collection('users');
  const step = verifyCode(user.totp.secret, code.trim(), { lastStep: user.totp.lastStep ?? -1 });
  if (step !== null) {
    const { modifiedCount } = await users.updateOne(
      { _id: user._id, $or: [{ 'totp.lastStep': { $lt: step } }, { 'totp.lastStep': { $exists: false } }] },
      { $set: { 'totp.lastStep': step } },
    );
    return modifiedCount ? 'app' : null;
  }
  const hash = hashToken(`recovery:${normalizeRecoveryCode(code)}`);
  const { modifiedCount } = await users.updateOne(
    { _id: user._id, 'totp.recoveryHashes': hash },
    { $pull: { 'totp.recoveryHashes': hash } },
  );
  return modifiedCount ? 'recovery' : null;
}

export const recoveryHashes = (codes) => codes.map((c) => hashToken(`recovery:${normalizeRecoveryCode(c)}`));

// A login ticket for a user whose password was right: the token goes to the browser, its hash in the database.
export async function createLoginTicket(db, userId) {
  const token = randomBytes(32).toString('base64url');
  await db.collection('loginChallenges').insertOne({
    tokenHash: hashToken(token),
    userId,
    wrongCodes: 0,
    expiresAt: new Date(Date.now() + TICKET_MINUTES * 60_000),
  });
  return token;
}
