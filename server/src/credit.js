import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireUser } from './auth.js';
import { HttpError, parse, parseObjectId } from './http.js';
import { logActivity, rupees } from './activity.js';
import { creditAddedEmail } from './emails.js';
import { requirePermission } from './staff.js';

// Store credit (stage 72): money a customer holds with the store, in paise, spent at checkout before paying (it is a
// way of paying, like cash, so invoices and GST don't change). It comes from returns refunded as credit, the credit
// part of cancelled orders, and goodwill an admin adds from a help request. It never expires.
// `users.credit` is the balance; collection `creditLedger` has one entry per change:
// { userId, change (+ in, − out), balance (after), reason (REASONS), orderId?, orderNumber?, returnId?,
//   helpRequestId?, note?, by: { id, name } | null, at }
// Invariant: every change to users.credit inserts its entry in the same transaction (addCredit), so the balance is
// always the sum of the ledger, and a spend has the balance check in its update filter (it can't go below zero).

export const REASONS = {
  goodwill: 'Added by the store',
  taken: 'Taken back by the store',
  returned: 'Return refunded as credit',
  cancelled: 'Credit back from a cancelled order',
  spent: 'Paid for an order',
  gift_card: 'Gift card redeemed',
  cashback: 'Cashback',
};
export const MAX_GRANT = 1_000_000; // ₹10,000 per goodwill change
const PAGE = 50;

// routes/reviews.js has the same; not imported from there, because orders.js and payments.js import this module and
// that one leads back to them.
async function inTransaction(client, work) {
  const session = client.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

// Adds `change` paise (negative to spend) to a customer's credit and records it, inside `session`'s transaction.
// Returns the new balance; throws 409 when a spend is more than the balance.
export async function addCredit(db, userId, change, entry, session) {
  if (!change) return null;
  const user = await db
    .collection('users')
    .findOneAndUpdate(
      { _id: userId, ...(change < 0 && { credit: { $gte: -change } }) },
      { $inc: { credit: change } },
      { session, returnDocument: 'after', projection: { credit: 1 } },
    );
  if (!user) {
    throw new HttpError(
      409,
      change < 0 ? 'Your store credit has changed. Check the order again.' : 'Account not found',
    );
  }
  await db
    .collection('creditLedger')
    .insertOne({ userId, change, balance: user.credit, at: new Date(), by: null, ...entry }, { session });
  return user.credit;
}

// The money an order still needs once store credit has paid its part: what Razorpay charges or COD collects.
export const amountDue = (order) => order.total - (order.creditUsed ?? 0);

export const toCreditEntry = (doc) => ({
  id: doc._id.toString(),
  at: doc.at,
  change: doc.change,
  balance: doc.balance,
  reason: doc.reason,
  note: doc.note ?? null,
  order: doc.orderId ? { id: doc.orderId.toString(), number: doc.orderNumber ?? null } : null,
});

export const grantBody = z.object({
  // Paise; negative takes credit back (a mistake), never below what the customer has.
  amount: z
    .number('Enter an amount')
    .int()
    .refine((n) => n !== 0, 'Enter an amount')
    .refine((n) => Math.abs(n) <= MAX_GRANT, `At most ${rupees(MAX_GRANT)} at a time`)
    .refine((n) => n % 100 === 0, 'Whole rupees only'),
  // Shown to the customer in their credit history and the email.
  note: z.string().trim().min(3, 'Say why, for the customer').max(200, 'At most 200 characters'),
});
const pageQuery = z.object({ page: z.coerce.number().int().min(1).max(1000).default(1) });

// Goodwill from an admin (`by`) to `customer` (a users document): `amount` paise, negative to take back a mistake (never
// below zero, 409), with the note the customer sees. Logged (`label` names the customer) and, when adding, emailed.
// Used from a help request and from the customer's admin page. Returns the new balance.
export async function grantCredit(ctx, by, customer, { amount, note, helpRequestId, label }) {
  const { db, client, config } = ctx;
  const balance = await inTransaction(client, (session) =>
    addCredit(
      db,
      customer._id,
      amount,
      {
        reason: amount > 0 ? 'goodwill' : 'taken',
        note,
        ...(helpRequestId && { helpRequestId }),
        by: { id: by._id, name: by.name },
      },
      session,
    ).catch((err) => {
      if (err.status === 409) throw new HttpError(409, `They have only ${rupees(customer.credit ?? 0)} of credit`);
      throw err;
    }),
  );
  await logActivity(db, by, {
    area: 'accounts',
    action: amount > 0 ? 'Added store credit' : 'Took back store credit',
    target: { label, path: `/admin/customers/${customer._id}` },
    changes: [
      { field: 'Amount', to: rupees(Math.abs(amount)) },
      { field: 'Balance', to: rupees(balance) },
      { field: 'Note', to: note },
    ],
  });
  if (amount > 0) {
    try {
      await ctx.mail.send({
        to: { email: customer.email, name: customer.name },
        ...creditAddedEmail(customer, { amount, note, balance }, config.mail?.publicUrl),
      });
    } catch (err) {
      console.error(`Could not email the store credit to ${customer._id}:`, err.message);
    }
  }
  return balance;
}

export function creditRouter(ctx) {
  const { db } = ctx;
  const ledger = db.collection('creditLedger');
  const router = express.Router();

  router.get('/account/credit', requireUser, async (req, res) => {
    const { page } = parse(pageQuery, req.query);
    const filter = { userId: req.user._id };
    const [items, total] = await Promise.all([
      ledger
        .find(filter)
        .sort({ at: -1, _id: -1 })
        .skip((page - 1) * PAGE)
        .limit(PAGE)
        .toArray(),
      ledger.countDocuments(filter),
    ]);
    res.json({ balance: req.user.credit ?? 0, items: items.map(toCreditEntry), total, page, pageSize: PAGE });
  });

  // Goodwill from a help request (admins only: it is money). The customer is emailed; guests' requests can't get it.
  router.post('/admin/help/:id/credit', requirePermission('*'), async (req, res) => {
    const _id = parseObjectId(req.params.id, 'request id');
    const { amount, note } = parse(grantBody, req.body);
    const request = await db.collection('helpRequests').findOne({ _id });
    if (!request) throw new HttpError(404, 'Help request not found');
    if (!request.userId) throw new HttpError(409, 'This request is from a guest: store credit needs an account');
    const customer = await db.collection('users').findOne({ _id: request.userId });
    if (!customer) throw new HttpError(409, 'This customer closed their account');
    const balance = await grantCredit(ctx, req.user, customer, {
      amount,
      note,
      helpRequestId: _id,
      label: `${customer.name} (request #${request.number})`,
    });
    res.json({ balance });
  });

  // An admin's look at a help request's customer: their balance (for the help page's credit form).
  router.get('/admin/help/:id/credit', requirePermission('*'), async (req, res) => {
    const request = await db
      .collection('helpRequests')
      .findOne({ _id: parseObjectId(req.params.id, 'request id') }, { projection: { userId: 1 } });
    if (!request) throw new HttpError(404, 'Help request not found');
    const customer =
      request.userId &&
      (await db.collection('users').findOne({ _id: new ObjectId(request.userId) }, { projection: { credit: 1 } }));
    res.json({ balance: customer ? (customer.credit ?? 0) : null });
  });

  return router;
}
