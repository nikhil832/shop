import express from 'express';
import { z } from 'zod';
import {
  SESSION_COOKIE,
  SESSION_DAYS,
  createSession,
  deleteSession,
  hashPassword,
  readSessionCookie,
  sessionCookieOptions,
  toUser,
  verifyPassword,
} from '../auth.js';
import { HttpError, parse } from '../http.js';

const email = z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email'));

const registerBody = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(80),
  email,
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

const loginBody = z.object({
  email,
  password: z.string().min(1, 'Enter your password').max(128),
});

// Compared against when the email is unknown, so both cases take about as long.
const DUMMY_HASH = await hashPassword('not-a-real-password');

export function authRouter({ db }) {
  const users = db.collection('users');
  const router = express.Router();

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
    const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, 'Wrong email or password');
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
