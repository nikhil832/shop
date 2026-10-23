import express from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  SESSION_COOKIE,
  SESSION_DAYS,
  checkPassword,
  clientIp,
  networkOf,
  clearPasswordAttempts,
  createSession,
  deleteSession,
  hashPassword,
  hashToken,
  readSessionCookie,
  sessionCookieOptions,
  toUser,
  verifyPassword,
} from '../auth.js';
import { passwordResetEmail, RESET_LINK_MINUTES } from '../emails.js';
import { HttpError, parse } from '../http.js';

const email = z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email'));

export const newPassword = z.string().min(8, 'Password must be at least 8 characters').max(128);

const registerBody = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(80),
  email,
  password: newPassword,
});

const loginBody = z.object({
  email,
  password: z.string().min(1, 'Enter your password').max(128),
});

const forgotBody = z.object({ email });

const resetBody = z.object({
  // A malformed token matches no stored link, so it gets the same answer as an expired one.
  token: z.string().max(100),
  password: newPassword,
});

// Reset emails per account per hour, so the form can't be used to flood someone's inbox.
const MAX_RESETS_PER_HOUR = 3;
const BAD_RESET_LINK = 'This reset link has expired or was already used. Ask for a new one.';

export const SAME_PASSWORD = 'Your new password must be different from your current one.';

export function authRouter(ctx) {
  const { db } = ctx;
  const users = db.collection('users');
  const resets = db.collection('passwordResets');

  const router = express.Router();

  // Emails a one-time link (token after #, so it never reaches server logs or other sites). Only its hash is stored.
  async function sendPasswordReset(user) {
    const now = Date.now();
    const recent = await resets.countDocuments({ userId: user._id, createdAt: { $gt: new Date(now - 3_600_000) } });
    if (recent >= MAX_RESETS_PER_HOUR) return;
    const token = randomBytes(32).toString('base64url');
    await resets.insertOne({
      tokenHash: hashToken(token),
      userId: user._id,
      createdAt: new Date(now),
      expiresAt: new Date(now + RESET_LINK_MINUTES * 60_000),
    });
    const url = `${ctx.config.mail?.publicUrl ?? 'http://localhost:5173'}/reset-password#token=${token}`;
    await ctx.mail.send({ to: { email: user.email, name: user.name }, ...passwordResetEmail(user, url) });
  }

  async function startSession(req, res, user) {
    const token = await createSession(db, user._id);
    res.cookie(SESSION_COOKIE, token, { ...sessionCookieOptions(req), maxAge: SESSION_DAYS * 86_400_000 });
  }

  router.get('/auth/me', (req, res) => {
    res.json({ user: req.user && toUser(req.user) });
  });

  router.post('/auth/register', async (req, res) => {
    const body = parse(registerBody, req.body);
    const doc = {
      name: body.name,
      email: body.email,
      passwordHash: await hashPassword(body.password),
      role: 'user', // admins are made with `npm run make-admin`, never through the API
      createdAt: new Date(),
    };
    try {
      const { insertedId } = await users.insertOne(doc);
      doc._id = insertedId;
    } catch (err) {
      if (err.code === 11000) throw new HttpError(409, 'An account with this email already exists');
      throw err;
    }
    await startSession(req, res, doc);
    res.status(201).json({ user: toUser(doc) });
  });

  router.post('/auth/login', async (req, res) => {
    const body = parse(loginBody, req.body);
    const user = await users.findOne({ email: body.email });
    const network = networkOf(clientIp(req, ctx.config));
    if (!(await checkPassword(db, body.email, body.password, user?.passwordHash, network))) {
      throw new HttpError(401, 'Wrong email or password');
    }
    await startSession(req, res, user);
    res.json({ user: toUser(user) });
  });

  router.post('/auth/forgot-password', async (req, res) => {
    const body = parse(forgotBody, req.body);
    const user = await users.findOne({ email: body.email });
    // Not awaited, and the same answer either way: neither the reply nor its timing says whether the account exists.
    if (user) {
      sendPasswordReset(user).catch((err) => console.error('Could not send a password reset email:', err.message));
    }
    res.status(204).end();
  });

  router.post('/auth/reset-password', async (req, res) => {
    const body = parse(resetBody, req.body);
    const live = { tokenHash: hashToken(body.token), expiresAt: { $gt: new Date() } };
    const pending = await resets.findOne(live);
    const current = pending && (await users.findOne({ _id: pending.userId }));
    if (!current) throw new HttpError(400, BAD_RESET_LINK);
    // Checked before the link is used up, so the customer can choose another password with the same link.
    if (await verifyPassword(body.password, current.passwordHash)) throw new HttpError(400, SAME_PASSWORD);
    // Claimed and deleted in one step, so a link works only once even if submitted twice at the same moment.
    const reset = await resets.findOneAndDelete(live);
    if (!reset) throw new HttpError(400, BAD_RESET_LINK);
    const user = await users.findOneAndUpdate(
      { _id: reset.userId },
      { $set: { passwordHash: await hashPassword(body.password) } },
      { returnDocument: 'after' },
    );
    if (!user) throw new HttpError(400, BAD_RESET_LINK);
    // The account's other reset links and every session (on any device) stop working; this browser logs in afresh.
    // A login lock on the account ends too: proving access to the email is enough.
    await Promise.all([
      resets.deleteMany({ userId: user._id }),
      db.collection('sessions').deleteMany({ userId: user._id }),
      clearPasswordAttempts(db, user.email),
    ]);
    await startSession(req, res, user);
    res.json({ user: toUser(user) });
  });

  router.post('/auth/logout', async (req, res) => {
    await deleteSession(db, readSessionCookie(req));
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions(req));
    res.status(204).end();
  });

  return router;
}
