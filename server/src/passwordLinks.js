import { randomBytes } from 'node:crypto';
import { hashToken } from './auth.js';

// "Set a password" links (stage 84) for accounts made at checkout without one: the same one-time links as password
// resets (`passwordResets`, used on the reset page), but they last SET_PASSWORD_DAYS, as order emails are read later.
export const SET_PASSWORD_DAYS = 7;

export async function setPasswordLink(db, userId, publicUrl = 'http://localhost:5173') {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  await db.collection('passwordResets').insertOne({
    tokenHash: hashToken(token),
    userId,
    purpose: 'set',
    createdAt: new Date(now),
    expiresAt: new Date(now + SET_PASSWORD_DAYS * 86_400_000),
  });
  return `${publicUrl}/reset-password#token=${token}`;
}
