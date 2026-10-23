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
import { HttpError, parse } from '../http.js';
import { newPassword, SAME_PASSWORD } from './auth.js';
import { address } from './orders.js';

// The logged-in customer's own details. The email can't be changed here (that would need a confirmation email).
const detailsBody = z.object({ name: z.string().trim().min(1, 'Enter your name').max(80) });
const addressBody = z.object({ address });
const passwordBody = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(128),
  newPassword,
});

export function accountRouter({ db, config }) {
  const users = db.collection('users');
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

  return router;
}
