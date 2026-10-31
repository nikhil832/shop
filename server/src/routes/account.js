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
import { HttpError, parse, parseObjectId } from '../http.js';
import { MAX_ADDRESSES, hasAddress, newAddress } from '../addressBook.js';
import { email, newPassword, SAME_PASSWORD } from './auth.js';
import { newRecoveryCodes, newSecret, otpauthUri, verifyCode } from '../totp.js';
import { checkSecondStep, hasTwoStep, recoveryHashes } from '../twoStep.js';
import { takeHourlySlot } from '../rateLimit.js';
import { address } from './orders.js';

// The logged-in customer's own details. A new email only takes effect once confirmed by a link sent to it.
const detailsBody = z.object({ name: z.string().trim().min(1, 'Enter your name').max(80) });
const addressBody = z.object({ address, label: z.string().trim().max(30, 'At most 30 characters').default('') });
const emailPreferencesBody = z
  .object({
    priceDropEmails: z.boolean().optional(),
    cartReminderEmails: z.boolean().optional(),
    reviewReminderEmails: z.boolean().optional(),
    restockReminderEmails: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Say which emails to switch');
const passwordBody = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(128),
  newPassword,
});

const emailChangeBody = z.object({
  newEmail: email,
  password: z.string().min(1, 'Enter your password').max(128),
});
const confirmEmailBody = z.object({ token: z.string().max(100) });
const passwordOnly = z.object({ password: z.string().min(1, 'Enter your password').max(128) });
const codeOnly = z.object({ code: z.string().trim().min(1, 'Enter the code').max(20) });
const passwordAndCode = passwordOnly.extend(codeOnly.shape);
// How long a two-step setup (the secret shown, not yet confirmed with a code) stays usable.
const SETUP_MINUTES = 15;

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

  // Which optional emails the customer gets: price drops on their wishlist, a reminder about a cart left behind, a request
  // for reviews after delivery (order emails always go). Each is sent on its own.
  router.put('/account/email-preferences', async (req, res) => {
    const choices = parse(emailPreferencesBody, req.body);
    res.json({ user: await update(req, { $set: choices }) });
  });

  // The address book (addressBook.js): up to MAX_ADDRESSES, the first is the default. Each change is one update with
  // its checks in the filter, so two tabs can't go past the limit.
  router.post('/account/addresses', async (req, res) => {
    const body = parse(addressBody, req.body);
    const after = await users.findOneAndUpdate(
      { _id: req.user._id, [`addresses.${MAX_ADDRESSES - 1}`]: { $exists: false }, $nor: [hasAddress(body.address)] },
      { $push: { addresses: newAddress(body.address, body.label) } },
      { returnDocument: 'after' },
    );
    if (!after) {
      const user = await users.findOne({ _id: req.user._id, ...hasAddress(body.address) }, { projection: { _id: 1 } });
      throw new HttpError(
        409,
        user ? 'This address is already saved' : `You can keep up to ${MAX_ADDRESSES} addresses`,
      );
    }
    res.status(201).json({ user: toUser(after) });
  });

  router.put('/account/addresses/:id', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'address id');
    const body = parse(addressBody, req.body);
    const entry = Object.fromEntries(
      Object.entries(newAddress(body.address, body.label)).map(([k, v]) => [`addresses.$.${k}`, v]),
    );
    delete entry['addresses.$._id'];
    const after = await users.findOneAndUpdate(
      { _id: req.user._id, 'addresses._id': _id },
      { $set: entry },
      { returnDocument: 'after' },
    );
    if (!after) throw new HttpError(404, 'Address not found');
    res.json({ user: toUser(after) });
  });

  // Removing the default makes the next one the default.
  router.delete('/account/addresses/:id', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'address id');
    const after = await users.findOneAndUpdate(
      { _id: req.user._id, 'addresses._id': _id },
      { $pull: { addresses: { _id } } },
      { returnDocument: 'after' },
    );
    if (!after) throw new HttpError(404, 'Address not found');
    res.json({ user: toUser(after) });
  });

  // Makes an address the default by moving it to the front.
  router.post('/account/addresses/:id/default', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'address id');
    const after = await users.findOneAndUpdate(
      { _id: req.user._id, 'addresses._id': _id },
      [
        {
          $set: {
            addresses: {
              $concatArrays: [
                { $filter: { input: '$addresses', cond: { $eq: ['$$this._id', _id] } } },
                { $filter: { input: '$addresses', cond: { $ne: ['$$this._id', _id] } } },
              ],
            },
          },
        },
      ],
      { returnDocument: 'after' },
    );
    if (!after) throw new HttpError(404, 'Address not found');
    res.json({ user: toUser(after) });
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

  // ---- Two-step login ----

  // Step 1, with the password: a new secret for the authenticator app (shown as a QR code and a setup key). It only
  // takes effect once a code from the app confirms it (step 2), so a mistyped setup can't lock anyone out.
  router.post('/account/two-step/setup', async (req, res) => {
    const { password } = parse(passwordOnly, req.body);
    const { _id, email: current, passwordHash } = req.user;
    if (hasTwoStep(req.user)) throw new HttpError(409, 'Two-step login is already on');
    if (!(await checkPassword(db, current, password, passwordHash, networkOf(clientIp(req, config))))) {
      throw new HttpError(400, 'Your password is wrong');
    }
    const secret = newSecret();
    await users.updateOne({ _id }, { $set: { totpSetup: { secret, createdAt: new Date() } } });
    res.json({ secret, uri: otpauthUri(secret, current) });
  });

  // Step 2: a code from the app turns it on, and the one-time recovery codes are shown (only now, only once). Other
  // devices are logged out; this one stays.
  router.post('/account/two-step/enable', async (req, res) => {
    const { code } = parse(codeOnly, req.body);
    const { _id, totpSetup } = req.user;
    if (hasTwoStep(req.user)) throw new HttpError(409, 'Two-step login is already on');
    if (!totpSetup || totpSetup.createdAt < new Date(Date.now() - SETUP_MINUTES * 60_000)) {
      throw new HttpError(409, 'Start the setup again: it expires after 15 minutes');
    }
    const step = verifyCode(totpSetup.secret, code);
    if (step === null) throw new HttpError(400, "That code doesn't match. Check the app and try the newest code.");
    const recoveryCodes = newRecoveryCodes();
    const { modifiedCount } = await users.updateOne(
      { _id, 'totpSetup.secret': totpSetup.secret, 'totp.enabledAt': { $exists: false } },
      {
        $set: {
          totp: {
            secret: totpSetup.secret,
            enabledAt: new Date(),
            lastStep: step,
            recoveryHashes: recoveryHashes(recoveryCodes),
          },
        },
        $unset: { totpSetup: '' },
      },
    );
    if (!modifiedCount) throw new HttpError(409, 'Two-step login is already on');
    await db.collection('sessions').deleteMany({ userId: _id, tokenHash: { $ne: hashToken(readSessionCookie(req)) } });
    res.json({ user: toUser(await users.findOne({ _id })), recoveryCodes });
  });

  // New recovery codes (the old ones stop working), with a code from the app.
  router.post('/account/two-step/recovery-codes', async (req, res) => {
    const { code } = parse(codeOnly, req.body);
    if (!hasTwoStep(req.user)) throw new HttpError(409, 'Two-step login is off');
    if ((await checkSecondStep(db, req.user, code)) !== 'app') {
      throw new HttpError(400, 'Enter a code from your authenticator app');
    }
    const recoveryCodes = newRecoveryCodes();
    await users.updateOne({ _id: req.user._id }, { $set: { 'totp.recoveryHashes': recoveryHashes(recoveryCodes) } });
    res.json({ recoveryCodes });
  });

  // Turning it off needs the password and a code (app or recovery), so a stolen session alone can't.
  router.post('/account/two-step/disable', async (req, res) => {
    const { password, code } = parse(passwordAndCode, req.body);
    const { _id, email: current, passwordHash } = req.user;
    if (!hasTwoStep(req.user)) throw new HttpError(409, 'Two-step login is off');
    if (!(await checkPassword(db, current, password, passwordHash, networkOf(clientIp(req, config))))) {
      throw new HttpError(400, 'Your password is wrong');
    }
    if (!(await checkSecondStep(db, req.user, code)))
      throw new HttpError(400, 'That code is wrong or was already used');
    const user = await users.findOneAndUpdate(
      { _id },
      { $unset: { totp: '', totpSetup: '' } },
      { returnDocument: 'after' },
    );
    res.json({ user: toUser(user) });
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
    // Taken in one atomic update, so requests sent at once can't all pass.
    if (!(await takeHourlySlot(db, `emailChange:${_id}`, MAX_EMAIL_CHANGES_PER_HOUR))) {
      throw new HttpError(429, 'Too many confirmation emails in the last hour. Try again later.');
    }
    const now = Date.now();
    const token = randomBytes(32).toString('base64url');
    const { insertedId } = await emailChanges.insertOne({
      tokenHash: hashToken(token),
      userId: _id,
      newEmail: body.newEmail,
      createdAt: new Date(now),
      expiresAt: new Date(now + EMAIL_CHANGE_HOURS * 3_600_000),
    });
    // Earlier requests stop working.
    await emailChanges.updateMany({ userId: _id, _id: { $ne: insertedId } }, { $set: { expiresAt: new Date(now) } });
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
