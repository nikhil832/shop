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
import { toExchange } from './exchanges.js';
import { changeRating, inTransaction, toReview } from './reviews.js';
import { toCreditEntry } from '../credit.js';
import { toGiftCard } from '../giftCards.js';

// A customer's own data (stage 65), for India's data protection law (DPDP Act 2023): download everything the store
// holds about them, or close the account.
// Closing deletes the account and what's only theirs (sessions, login and reset links, wishlist, alerts, saved cart,
// reviews (out of the ratings too), unanswered questions, help requests), signs answered questions "A customer", and
// keeps orders and returns, which tax law needs, with the name, phone and street removed (city, state and PIN stay:
// GST's place of supply). It's refused while an order is on its way or a return or exchange is open, and for admins.

const ORDER_OPEN = ['awaiting_payment', 'placed', 'shipped'];
const RETURN_OPEN = ['requested', 'approved', 'refunding', 'refund_failed'];
const EXCHANGE_OPEN = ['requested', 'approved', 'shipped'];
// Collections that only hold this customer's own records, by userId.
const OWN = [
  'wishlist',
  'stockAlerts',
  'passwordResets',
  'emailChanges',
  'loginChallenges',
  'loginCodes',
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
    const [orders, returns, exchanges, reviews, questions, wishlist, alerts, cart, help, credit, giftCards, votes] =
      await Promise.all([
        db.collection('orders').find({ userId }).sort({ createdAt: -1 }).toArray(),
        db.collection('returns').find({ userId }).sort({ createdAt: -1 }).toArray(),
        db.collection('exchanges').find({ userId }).sort({ createdAt: -1 }).toArray(),
        db.collection('reviews').find({ userId }).toArray(),
        db.collection('questions').find({ userId }).toArray(),
        db.collection('wishlist').find({ userId }).toArray(),
        db.collection('stockAlerts').find({ userId }).toArray(),
        db.collection('carts').findOne({ _id: userId }),
        db.collection('helpRequests').find({ userId }).toArray(),
        db.collection('creditLedger').find({ userId }).sort({ at: -1 }).toArray(),
        db
          .collection('giftCards')
          .find({ buyerId: userId, status: { $ne: 'awaiting_payment' } })
          .toArray(),
        db.collection('reviewVotes').countDocuments({ userId }),
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
        emails: {
          priceDrops: u.priceDropEmails !== false,
          cartReminders: u.cartReminderEmails !== false,
          reviewReminders: u.reviewReminderEmails !== false,
        },
        addresses: (u.addresses ?? []).map(toAddress),
        // What the store's staff noted about this account (stage 82).
        storeTags: u.tags ?? [],
        storeNotes: (u.adminNotes ?? []).map((n) => ({ text: n.text, at: n.at })),
      },
      orders: orders.map((o) => toOrder(o)),
      returns: returns.map(toReturn),
      exchanges: exchanges.map(toExchange),
      reviews: reviews.map((r) => ({ product: title(r.productId), ...toReview(r) })),
      // How many other customers' reviews they marked helpful (which ones isn't shown to anyone).
      helpfulVotes: votes,
      questions: questions.map((q) => ({ product: title(q.productId), ...toQuestion(q) })),
      wishlist: wishlist.map((w) => ({ product: title(w.productId), addedAt: w.addedAt })),
      // Whether it's shared by a link (stage 106); the link itself is on the wishlist page.
      wishlistShared: Boolean(u.wishlistShare),
      backInStockAlerts: alerts.map((a) => ({ product: title(a.productId), createdAt: a.createdAt })),
      savedCart: cart ? { items: cart.items, updatedAt: cart.updatedAt } : null,
      helpRequests: help.map(toRequest),
      storeCredit: { balance: u.credit ?? 0, history: credit.map(toCreditEntry) },
      // Cards they bought (never the codes, which aren't kept).
      giftCardsBought: giftCards.map((c) => toGiftCard(c)),
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
    if (
      await db.collection('exchanges').findOne({ userId, status: { $in: EXCHANGE_OPEN } }, { projection: { _id: 1 } })
    ) {
      throw new HttpError(409, 'You have an exchange in progress. You can close your account once it is finished.');
    }

    await inTransaction(client, async (session) => {
      // Reviews leave the ratings they were counted in (hidden ones weren't).
      const ownReviews = await db.collection('reviews').find({ userId }, { session }).toArray();
      const reviewIds = ownReviews.map((r) => r._id);
      for (const r of ownReviews) {
        if (!r.hidden) await changeRating(db, r.productId, { sum: -r.rating, count: -1 }, session);
      }
      // Their helpful votes come off the reviews they were counted on; votes on their own reviews go with them.
      for (const v of await db.collection('reviewVotes').find({ userId }, { session }).toArray()) {
        await db.collection('reviews').updateOne({ _id: v.reviewId }, { $inc: { helpful: -1 } }, { session });
      }
      await db.collection('reviewVotes').deleteMany({ userId }, { session });
      await db.collection('reviewVotes').deleteMany({ reviewId: { $in: reviewIds } }, { session });
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
          // Earlier delivery addresses (stage 90) hold the same details.
          // Delivery instructions may hold personal details too (stage 113), as may a cancellation note (stage 122).
          $unset: { addressChanges: '', deliveryInstructions: '', 'cancelReason.note': '' },
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
