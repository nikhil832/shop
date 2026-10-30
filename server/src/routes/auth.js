import express from 'express';
import { randomBytes, randomInt } from 'node:crypto';
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
import { LOGIN_CODE_MINUTES, loginCodeEmail, passwordResetEmail, RESET_LINK_MINUTES } from '../emails.js';
import { takeHourlySlot } from '../rateLimit.js';
import { MAX_WRONG_CODES, checkSecondStep, createLoginTicket, hasTwoStep } from '../twoStep.js';
import { HttpError, parse } from '../http.js';
import { noteAdminLogin } from '../loginAlerts.js';
import { referrerFor } from '../referrals.js';

export const email = z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email'));

export const newPassword = z.string().min(8, 'Password must be at least 8 characters').max(128);

const registerBody = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(80),
  email,
  password: newPassword,
  // The referral code of the friend whose link they came from (stage 87); an unknown one is ignored.
  ref: z.string().trim().max(20).optional(),
});

const quickBody = registerBody.omit({ password: true });
const QUICK_ACCOUNTS_PER_HOUR = 5; // per visitor network

const loginBody = z.object({
  email,
  password: z.string().min(1, 'Enter your password').max(128),
});

const forgotBody = z.object({ email });
// Logging in with an emailed code (stage 110).
const emailCodeBody = z.object({
  email,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code from the email'),
});
const MAX_CODE_EMAILS_PER_HOUR = 3;
const MAX_WRONG_EMAIL_CODES = 5;
// Guesses at codes from one network, whatever the account, per hour.
const MAX_CODE_TRIES_PER_HOUR = 30;
const EMAIL_CODE_EXPIRED = 'This code has expired or was replaced by a newer one. Ask for a new code.';
const codeBody = z.object({
  ticket: z.string().max(100),
  code: z.string().trim().min(1, 'Enter the code').max(20),
});
const LOGIN_EXPIRED = 'This login has expired. Log in again.';

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
    // These run in the background, so several can run at once: the limit is taken in one atomic update.
    if (!(await takeHourlySlot(db, `reset:${user._id}`, MAX_RESETS_PER_HOUR))) return;
    const now = Date.now();
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

  // Every way of logging in ends here, so new-browser alerts for admins (loginAlerts.js) cover them all.
  async function startSession(req, res, user) {
    const token = await createSession(db, user._id);
    res.cookie(SESSION_COOKIE, token, { ...sessionCookieOptions(req), maxAge: SESSION_DAYS * 86_400_000 });
    await noteAdminLogin(ctx, req, res, user, clientIp(req, ctx.config) ?? 'unknown');
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
    const referredBy = await referrerFor(db, body.ref);
    if (referredBy) doc.referredBy = referredBy;
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

  // Checkout without a password (stage 84): an account from just a name and email, logged in at once, so a new
  // customer can order. A link to set a password comes with the order confirmation (passwordLinks.js); until then it
  // can't be logged into with a password. An email with an account already must log in, as when signing up.
  router.post('/auth/quick-account', async (req, res) => {
    if (req.user) throw new HttpError(400, 'You are already logged in');
    const body = parse(quickBody, req.body);
    const network = networkOf(clientIp(req, ctx.config));
    if (!(await takeHourlySlot(db, `quickAccount:${hashToken(network)}`, QUICK_ACCOUNTS_PER_HOUR))) {
      throw new HttpError(429, 'Too many new accounts from here this hour. Please try again later.');
    }
    const doc = { name: body.name, email: body.email, passwordHash: null, role: 'user', createdAt: new Date() };
    const referredBy = await referrerFor(db, body.ref);
    if (referredBy) doc.referredBy = referredBy;
    try {
      const { insertedId } = await users.insertOne(doc);
      doc._id = insertedId;
    } catch (err) {
      if (err.code === 11000)
        throw new HttpError(409, 'There’s already an account with this email: log in to check out');
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
    // With two-step login, the password only earns a ticket for the code (POST /auth/login/code).
    if (hasTwoStep(user)) return res.json({ user: null, twoStep: true, ticket: await createLoginTicket(db, user._id) });
    await startSession(req, res, user);
    res.json({ user: toUser(user) });
  });

  // The second step: the ticket from /auth/login and a code from the authenticator app (or a recovery code).
  router.post('/auth/login/code', async (req, res) => {
    const body = parse(codeBody, req.body);
    const tickets = db.collection('loginChallenges');
    const live = { tokenHash: hashToken(body.ticket), expiresAt: { $gt: new Date() } };
    const ticket = await tickets.findOne(live);
    const user = ticket && (await users.findOne({ _id: ticket.userId }));
    if (!user || !hasTwoStep(user)) throw new HttpError(400, LOGIN_EXPIRED);
    const used = await checkSecondStep(db, user, body.code);
    if (!used) {
      const after = await tickets.findOneAndUpdate(live, { $inc: { wrongCodes: 1 } }, { returnDocument: 'after' });
      if (!after || after.wrongCodes >= MAX_WRONG_CODES) {
        await tickets.deleteOne({ _id: ticket._id });
        throw new HttpError(429, 'Too many wrong codes. Log in again.');
      }
      throw new HttpError(401, 'That code is wrong or was already used');
    }
    // A ticket is used once, even if two right codes arrive together.
    if (!(await tickets.findOneAndDelete({ _id: ticket._id }))) throw new HttpError(400, LOGIN_EXPIRED);
    await startSession(req, res, user);
    const fresh = await users.findOne({ _id: user._id });
    res.json({ user: toUser(fresh), recoveryCodesLeft: used === 'recovery' ? fresh.totp.recoveryHashes.length : null });
  });

  // Logging in with a code sent by email (stage 110), instead of the password: for customers who forgot it, and the
  // accounts made at checkout, which have none. `loginCodes` { userId, codeHash, wrong, createdAt, expiresAt } (TTL)
  // holds one live code per account: a new one replaces it. Asking always answers 204 and sends in the background, so
  // neither reveals whether the email has an account (like the reset link); at most MAX_CODE_EMAILS_PER_HOUR an hour.
  // A code allows MAX_WRONG_EMAIL_CODES wrong tries, each network MAX_CODE_TRIES_PER_HOUR tries an hour, and it works
  // once. With two-step login on, the code earns a ticket for the authenticator code, like the password.
  const loginCodes = db.collection('loginCodes');
  const codeHash = (userId, code) => hashToken(`logincode:${userId}:${code}`);

  async function sendLoginCode(user) {
    if (!(await takeHourlySlot(db, `loginCode:${user._id}`, MAX_CODE_EMAILS_PER_HOUR))) return;
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const now = Date.now();
    await loginCodes.deleteMany({ userId: user._id });
    await loginCodes.insertOne({
      userId: user._id,
      codeHash: codeHash(user._id, code),
      wrong: 0,
      createdAt: new Date(now),
      expiresAt: new Date(now + LOGIN_CODE_MINUTES * 60_000),
    });
    await ctx.mail.send({ to: { email: user.email, name: user.name }, ...loginCodeEmail(user, code) });
  }

  router.post('/auth/email-code', async (req, res) => {
    const body = parse(forgotBody, req.body);
    const user = await users.findOne({ email: body.email });
    if (user) sendLoginCode(user).catch((err) => console.error('Could not send a login code:', err.message));
    res.status(204).end();
  });

  router.post('/auth/email-code/login', async (req, res) => {
    const body = parse(emailCodeBody, req.body);
    const network = networkOf(clientIp(req, ctx.config));
    if (!(await takeHourlySlot(db, `loginCodeTry:${hashToken(network)}`, MAX_CODE_TRIES_PER_HOUR))) {
      throw new HttpError(429, 'Too many tries for now. Please try again in an hour.');
    }
    const user = await users.findOne({ email: body.email });
    const live = user && { userId: user._id, expiresAt: { $gt: new Date() } };
    const pending = live && (await loginCodes.findOne(live));
    if (!pending) throw new HttpError(400, EMAIL_CODE_EXPIRED);
    if (pending.codeHash !== codeHash(user._id, body.code)) {
      // Counted with the limit in the filter, so tries sent together can't all slip through.
      const after = await loginCodes.findOneAndUpdate(
        { _id: pending._id, wrong: { $lt: MAX_WRONG_EMAIL_CODES } },
        { $inc: { wrong: 1 } },
        { returnDocument: 'after' },
      );
      if (!after || after.wrong >= MAX_WRONG_EMAIL_CODES) {
        await loginCodes.deleteOne({ _id: pending._id });
        throw new HttpError(429, 'Too many wrong codes. Ask for a new code.');
      }
      throw new HttpError(401, 'That code is wrong');
    }
    // Used once, even if it arrives twice at the same moment.
    if (!(await loginCodes.findOneAndDelete({ _id: pending._id, wrong: { $lt: MAX_WRONG_EMAIL_CODES } }))) {
      throw new HttpError(400, EMAIL_CODE_EXPIRED);
    }
    if (hasTwoStep(user)) return res.json({ user: null, twoStep: true, ticket: await createLoginTicket(db, user._id) });
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
    // (An account made at checkout has no password yet: nothing to compare.)
    if (current.passwordHash && (await verifyPassword(body.password, current.passwordHash))) {
      throw new HttpError(400, SAME_PASSWORD);
    }
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
    // Proving access to the email is not enough with two-step login: the code is still needed to log in.
    if (hasTwoStep(user)) return res.json({ user: null, twoStep: true });
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
