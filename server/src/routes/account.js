import express from 'express';
import { z } from 'zod';
import {
  checkPassword,
  clientIp,
  networkOf,
  clearPasswordAttempts,
  hashPassword,
  hashToken,
  readSessionCookie,
  requireUser,
  toUser,
} from '../auth.js';
import { randomBytes } from 'node:crypto';
import { confirmEmailChangeEmail, EMAIL_CHANGE_HOURS, emailChangedEmail } from '../emails.js';
import { HttpError, parse } from '../http.js';
import { email, newPassword, SAME_PASSWORD } from './auth.js';
import { address } from './orders.js';

// The logged-in customer's own details. A new email only takes effect once confirmed by a link sent to it.
const detailsBody = z.object({ name: z.string().trim().min(1, 'Enter your name').max(80) });
const addressBody = z.object({ address });
const passwordBody = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(128),
  newPassword,
});

const emailChangeBody = z.object({
  newEmail: email,
  password: z.string().min(1, 'Enter your password').max(128),
});
const confirmEmailBody = z.object({ token: z.string().max(100) });

// Confirmation emails per account per hour, so the form can't be used to flood someone else's inbox.
const MAX_EMAIL_CHANGES_PER_HOUR = 3;
const BAD_EMAIL_LINK = 'This link has expired or was already used. Ask for a new one on your account page.';
const EMAIL_TAKEN = 'An account with this email already exists';

export function accountRouter(ctx) {
  const { db, config } = ctx;
  const users = db.collection('users');
  const emailChanges = db.collection('emailChanges');
  const router = express.Router();
  router.use('/account', requireUser);

  async function update(req, change) {
    return toUser(await users.findOneAndUpdate({ _id: req.user._id }, change, { returnDocument: 'after' }));
  }

  router.patch('/account', async (req, res) => {
    const { name } = parse(detailsBody, req.body);
    res.json({ user: await update(req, { $set: { name } }) });
  });

  // The address checkout fills in (placing an order also saves the one used).
  router.put('/account/address', async (req, res) => {
    const body = parse(addressBody, req.body);
    res.json({ user: await update(req, { $set: { address: body.address } }) });
  });

  router.delete('/account/address', async (req, res) => {
    res.json({ user: await update(req, { $unset: { address: '' } }) });
  });

  // Needs the current password (wrong ones count towards the same lock as logging in, so a stolen session can't be
  // used to guess it), refuses reusing it, and logs out every other device; this one stays logged in.
  router.post('/account/password', async (req, res) => {
    const body = parse(passwordBody, req.body);
    const { _id, email, passwordHash } = req.user;
    const network = networkOf(clientIp(req, config));
    if (!(await checkPassword(db, email, body.currentPassword, passwordHash, network))) {
      throw new HttpError(400, 'Your current password is wrong');
    }
    if (body.newPassword === body.currentPassword) throw new HttpError(400, SAME_PASSWORD);
    await users.updateOne({ _id }, { $set: { passwordHash: await hashPassword(body.newPassword) } });
    await Promise.all([
      db.collection('sessions').deleteMany({ userId: _id, tokenHash: { $ne: hashToken(readSessionCookie(req)) } }),
      db.collection('passwordResets').deleteMany({ userId: _id }),
      clearPasswordAttempts(db, email),
    ]);
    res.status(204).end();
  });

  // ---- Changing the email ----

  const pendingChange = (userId) => emailChanges.findOne({ userId, expiresAt: { $gt: new Date() } });

  router.get('/account/email', async (req, res) => {
    const pending = await pendingChange(req.user._id);
    res.json({ pendingEmail: pending?.newEmail ?? null, expiresAt: pending?.expiresAt ?? null });
  });

  // Needs the password (a stolen session alone can't move the account), then emails a one-time link to the new
  // address (token after #, only its hash stored). A newer request replaces an older one.
  router.post('/account/email', async (req, res) => {
    const body = parse(emailChangeBody, req.body);
    const { _id, name, email: current, passwordHash } = req.user;
    const network = networkOf(clientIp(req, config));
    if (!(await checkPassword(db, current, body.password, passwordHash, network))) {
      throw new HttpError(400, 'Your password is wrong');
    }
    if (body.newEmail === current) throw new HttpError(400, "That's already your email");
    // Signing up says the same, so this tells nobody anything new.
    if (await users.findOne({ email: body.newEmail }, { projection: { _id: 1 } }))
      throw new HttpError(409, EMAIL_TAKEN);
    const now = Date.now();
    const recent = await emailChanges.countDocuments({ userId: _id, createdAt: { $gt: new Date(now - 3_600_000) } });
    if (recent >= MAX_EMAIL_CHANGES_PER_HOUR) {
      throw new HttpError(429, 'Too many confirmation emails in the last hour. Try again later.');
    }
    const token = randomBytes(32).toString('base64url');
    // Earlier requests stay (they count towards the hourly limit) but stop working.
    await emailChanges.updateMany({ userId: _id }, { $set: { expiresAt: new Date(now) } });
    const { insertedId } = await emailChanges.insertOne({
      tokenHash: hashToken(token),
      userId: _id,
      newEmail: body.newEmail,
      createdAt: new Date(now),
      expiresAt: new Date(now + EMAIL_CHANGE_HOURS * 3_600_000),
    });
    const url = `${config.mail?.publicUrl ?? 'http://localhost:5173'}/confirm-email#token=${token}`;
    try {
      await ctx.mail.send({
        to: { email: body.newEmail, name },
        ...confirmEmailChangeEmail(req.user, body.newEmail, url),
      });
    } catch (err) {
      console.error('Could not send an email change confirmation:', err.message);
      await emailChanges.deleteOne({ _id: insertedId });
      throw new HttpError(502, "We couldn't send the confirmation email. Try again in a moment.", { expose: true });
    }
    res.status(201).json({ pendingEmail: body.newEmail });
  });

  router.delete('/account/email', async (req, res) => {
    await emailChanges.updateMany({ userId: req.user._id }, { $set: { expiresAt: new Date() } });
    res.status(204).end();
  });

  // Opened from the confirmation email, on any device and logged in or not: the link itself proves the new address.
  router.post('/auth/confirm-email', async (req, res) => {
    const body = parse(confirmEmailBody, req.body);
    // Claimed and deleted in one step, so a link works only once.
    const change = await emailChanges.findOneAndDelete({
      tokenHash: hashToken(body.token),
      expiresAt: { $gt: new Date() },
    });
    if (!change) throw new HttpError(400, BAD_EMAIL_LINK);
    const before = await users.findOne({ _id: change.userId });
    if (!before) throw new HttpError(400, BAD_EMAIL_LINK);
    let user;
    try {
      user = await users.findOneAndUpdate(
        { _id: change.userId },
        { $set: { email: change.newEmail } },
        { returnDocument: 'after' },
      );
    } catch (err) {
      // Someone signed up with the address after the link was sent.
      if (err.code === 11000) throw new HttpError(409, EMAIL_TAKEN);
      throw err;
    }
    // Reset links went to the old address, so they stop working; so do any other pending changes.
    await Promise.all([
      emailChanges.deleteMany({ userId: user._id }),
      db.collection('passwordResets').deleteMany({ userId: user._id }),
      clearPasswordAttempts(db, before.email),
    ]);
    try {
      await ctx.mail.send({
        to: { email: before.email, name: user.name },
        ...emailChangedEmail(user, before.email, user.email),
      });
    } catch (err) {
      console.error('Could not send an email changed notice:', err.message);
    }
    // The page shows the new address; the logged-in user's own details are updated too.
    const own = req.user?._id.equals(user._id);
    res.json({ email: user.email, user: own ? toUser(user) : null });
  });

  return router;
}
