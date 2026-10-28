import express from 'express';
import { z } from 'zod';
import {
  checkPassword,
  clientIp,
  networkOf,
  readSessionCookie,
  requireUser,
  sessionCookieOptions,
  SESSION_COOKIE,
} from '../auth.js';
import { accountClosedEmail } from '../emails.js';
import { HttpError, parse } from '../http.js';
import { checkSecondStep, hasTwoStep } from '../twoStep.js';
import { isStaff } from '../staff.js';
import { toAddress } from '../addressBook.js';
import { toRequest } from './help.js';
import { toOrder } from './orders.js';
import { toQuestion } from './questions.js';
import { toReturn } from './returns.js';
import { changeRating, inTransaction, toReview } from './reviews.js';
import { toCreditEntry } from '../credit.js';

// A customer's own data (stage 65), for India's data protection law (DPDP Act 2023): download everything the store
// holds about them, or close the account.
// Closing deletes the account and what's only theirs (sessions, login and reset links, wishlist, alerts, saved cart,
// reviews (out of the ratings too), unanswered questions, help requests), signs answered questions "A customer", and
// keeps orders and returns, which tax law needs, with the name, phone and street removed (city, state and PIN stay:
// GST's place of supply). It's refused while an order is on its way or a return is open, and for admins.

const ORDER_OPEN = ['awaiting_payment', 'placed', 'shipped'];
const RETURN_OPEN = ['requested', 'approved', 'refunding', 'refund_failed'];
// Collections that only hold this customer's own records, by userId.
const OWN = [
  'wishlist',
  'stockAlerts',
  'passwordResets',
  'emailChanges',
  'loginChallenges',
  'helpRequests',
  'sessions',
  // Store credit's history; the balance goes with the account (closing gives up any credit left).
  'creditLedger',
];

const closeBody = z.object({
  password: z.string().min(1, 'Enter your password').max(128),
  code: z.string().trim().max(20).optional(),
  confirm: z.literal(true, 'Tick the box to confirm'),
});

export function accountDataRouter(ctx) {
  const { db, client, config } = ctx;
  const router = express.Router();
  router.use('/account/data', requireUser);
  router.use('/account/close', requireUser);

  // Everything about the logged-in customer, as a JSON file. No password hashes, two-step secrets or recovery codes.
  router.get('/account/data', async (req, res) => {
    const u = req.user;
    const userId = u._id;
    const [orders, returns, reviews, questions, wishlist, alerts, cart, help, credit] = await Promise.all([
      db.collection('orders').find({ userId }).sort({ createdAt: -1 }).toArray(),
      db.collection('returns').find({ userId }).sort({ createdAt: -1 }).toArray(),
      db.collection('reviews').find({ userId }).toArray(),
      db.collection('questions').find({ userId }).toArray(),
      db.collection('wishlist').find({ userId }).toArray(),
      db.collection('stockAlerts').find({ userId }).toArray(),
      db.collection('carts').findOne({ _id: userId }),
      db.collection('helpRequests').find({ userId }).toArray(),
      db.collection('creditLedger').find({ userId }).sort({ at: -1 }).toArray(),
    ]);
    const productIds = [...reviews, ...questions, ...wishlist, ...alerts].map((d) => d.productId);
    const titles = new Map(
      (
        await db
          .collection('products')
          .find({ _id: { $in: productIds } }, { projection: { title: 1 } })
          .toArray()
      ).map((p) => [p._id.toString(), p.title]),
    );
    const title = (id) => titles.get(id.toString()) ?? 'A product no longer sold';
    const data = {
      about: 'Everything Bazaar holds about your account, downloaded ' + new Date().toISOString(),
      account: {
        name: u.name,
        email: u.email,
        createdAt: u.createdAt,
        twoStepLogin: hasTwoStep(u),
        emails: { priceDrops: u.priceDropEmails !== false, cartReminders: u.cartReminderEmails !== false },
        addresses: (u.addresses ?? []).map(toAddress),
      },
      orders: orders.map((o) => toOrder(o)),
      returns: returns.map(toReturn),
      reviews: reviews.map((r) => ({ product: title(r.productId), ...toReview(r) })),
      questions: questions.map((q) => ({ product: title(q.productId), ...toQuestion(q) })),
      wishlist: wishlist.map((w) => ({ product: title(w.productId), addedAt: w.addedAt })),
      backInStockAlerts: alerts.map((a) => ({ product: title(a.productId), createdAt: a.createdAt })),
      savedCart: cart ? { items: cart.items, updatedAt: cart.updatedAt } : null,
      helpRequests: help.map(toRequest),
      storeCredit: { balance: u.credit ?? 0, history: credit.map(toCreditEntry) },
    };
    res.set(
      'Content-Disposition',
      `attachment; filename="bazaar-my-data-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    res.json(data);
  });

  // Closes the logged-in customer's account. Password (and two-step code) first; refused while anything is open.
  router.post('/account/close', async (req, res) => {
    const body = parse(closeBody, req.body);
    const u = req.user;
    if (isStaff(u))
      throw new HttpError(409, "Admin and staff accounts can't be closed here. Ask an admin to remove the role first.");
    if (!(await checkPassword(db, u.email, body.password, u.passwordHash, networkOf(clientIp(req, config))))) {
      throw new HttpError(400, 'Your password is wrong');
    }
    if (hasTwoStep(u) && !(await checkSecondStep(db, u, body.code ?? ''))) {
      throw new HttpError(400, 'Enter a code from your authenticator app (or a recovery code)');
    }
    const userId = u._id;
    if (await db.collection('orders').findOne({ userId, status: { $in: ORDER_OPEN } }, { projection: { _id: 1 } })) {
      throw new HttpError(
        409,
        'You have an order that is still on its way. You can close your account once it arrives.',
      );
    }
    if (await db.collection('returns').findOne({ userId, status: { $in: RETURN_OPEN } }, { projection: { _id: 1 } })) {
      throw new HttpError(409, 'You have a return in progress. You can close your account once it is finished.');
    }

    await inTransaction(client, async (session) => {
      // Reviews leave the ratings they were counted in (hidden ones weren't).
      for (const r of await db.collection('reviews').find({ userId }, { session }).toArray()) {
        if (!r.hidden) await changeRating(db, r.productId, { sum: -r.rating, count: -1 }, session);
      }
      await db.collection('reviews').deleteMany({ userId }, { session });
      await db.collection('questions').deleteMany({ userId, answer: null }, { session });
      await db
        .collection('questions')
        .updateMany({ userId }, { $set: { author: 'A customer', userId: null } }, { session });
      await db.collection('orders').updateMany(
        { userId },
        {
          $set: {
            'address.name': 'Closed account',
            'address.phone': '',
            'address.line1': '',
            'address.line2': '',
            customerClosedAt: new Date(),
          },
        },
        { session },
      );
      await db.collection('carts').deleteOne({ _id: userId }, { session });
      for (const name of OWN) await db.collection(name).deleteMany({ userId }, { session });
      await db.collection('users').deleteOne({ _id: userId }, { session });
    });

    try {
      await ctx.mail.send({ to: { email: u.email, name: u.name }, ...accountClosedEmail(u) });
    } catch (err) {
      console.error('Could not send the account-closed email:', err.message);
    }
    if (readSessionCookie(req)) res.clearCookie(SESSION_COOKIE, sessionCookieOptions(req));
    res.status(204).end();
  });

  return router;
}
