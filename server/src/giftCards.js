import { randomBytes } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { hashToken, requireAdmin, requireUser } from './auth.js';
import { HttpError, parse, parseObjectId } from './http.js';
import { logActivity, rupees } from './activity.js';
import { addCredit } from './credit.js';
import { giftCardCancelledEmail, giftCardEmail, giftCardReceiptEmail, giftCardReminderEmail } from './emails.js';
import { refundErrorText } from './payments.js';
import { takeHourlySlot } from './rateLimit.js';

// Gift cards (stage 77): a logged-in customer pays online (Razorpay) for a card of one of AMOUNTS for someone, emailed
// now or on a day they pick (≤ MAX_AHEAD_DAYS ahead, at SEND_HOUR India time). The recipient redeems the code into
// store credit (credit.js) within VALID_DAYS of the day it was sent; credit then never expires. Collection `giftCards`:
// { amount, buyerId, buyerName, recipient: { name, email }, message, sendAt, status, payment: { razorpayOrderId,
//   razorpayPaymentId, status: pending | paid | refunding | refunded | refund_failed, refundError? }, codeHash, last4,
//   code (only while scheduled), sentAt, expiresAt, reminderSentAt, redeemedBy, redeemedAt, cancelledAt, payBy,
//   createdAt }
// status: awaiting_payment → scheduled (paid, to send later) → sent → redeemed; or cancelled (an admin refunds an
// unredeemed card). Codes are kept only as a hash, like passwords: the code is made when the payment arrives, emailed
// to the buyer (a copy) and the recipient, and kept in `code` only until a scheduled card is sent. A card nobody paid
// for goes after UNPAID_DAYS (TTL on `payBy`, unset once paid).

export const AMOUNTS = [50000, 100000, 200000, 500000];
export const VALID_DAYS = 365;
export const REMIND_DAYS = 30;
export const MAX_AHEAD_DAYS = 90;
export const SEND_HOUR = 9;
export const UNPAID_DAYS = 7;
const BUYS_PER_HOUR = 10;
const REDEEMS_PER_HOUR = 10;
const DAY = 86_400_000;
const IST_OFFSET = 330 * 60_000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
const ADMIN_PAGE = 25;

// 16 random characters (80 bits) in four groups: BZ7Q-K2MD-…
export function newCode() {
  const chars = [...randomBytes(16)].map((b) => ALPHABET[b % 32]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}
export const normalCode = (code) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const codeHash = (code) => hashToken(`giftcard:${normalCode(code)}`);

const todayIst = (now) => new Date(now.getTime() + IST_OFFSET).toISOString().slice(0, 10);
// SEND_HOUR India time on `day` ('YYYY-MM-DD').
const sendTime = (day) => new Date(new Date(`${day}T00:00:00Z`).getTime() + SEND_HOUR * 3_600_000 - IST_OFFSET);

const email = z.string().trim().toLowerCase().max(254).pipe(z.email('Enter their email'));
const buyBody = z.object({
  amount: z.number().refine((n) => AMOUNTS.includes(n), 'Choose an amount'),
  recipientName: z.string().trim().min(1, 'Enter their name').max(80),
  recipientEmail: email,
  message: z.string().trim().max(300, 'At most 300 characters').default(''),
  // A day to send it (India time); none or today: as soon as it's paid.
  sendOn: z.iso.date('Choose a day').optional(),
});
const paymentBody = z.object({
  razorpay_order_id: z.string().max(100),
  razorpay_payment_id: z.string().max(100),
  razorpay_signature: z.string().max(200),
});
const redeemBody = z.object({ code: z.string().trim().max(40).pipe(z.string().min(1, 'Enter the code')) });
const adminQuery = z.object({
  status: z.enum(['scheduled', 'sent', 'redeemed', 'cancelled']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

export const toGiftCard = (doc, now = new Date()) => ({
  id: doc._id.toString(),
  amount: doc.amount,
  recipient: doc.recipient,
  message: doc.message,
  // A sent card past its date can't be redeemed any more.
  status: doc.status === 'sent' && doc.expiresAt <= now ? 'expired' : doc.status,
  last4: doc.last4 ?? null,
  sendAt: doc.sendAt,
  sentAt: doc.sentAt ?? null,
  expiresAt: doc.expiresAt ?? null,
  redeemedAt: doc.redeemedAt ?? null,
  createdAt: doc.createdAt,
});

const publicUrl = (ctx) => ctx.config.mail?.publicUrl;

async function sendRecipientEmail(ctx, card, code) {
  await ctx.mail.send({ to: card.recipient, ...giftCardEmail(card, code, publicUrl(ctx)) });
}

// Marks an awaiting card paid, given Razorpay's payment for it, makes its code and emails it (the buyer always, the
// recipient now unless it's for a later day). Safe to call again for the same payment: only the first call changes
// anything. Returns the card.
export async function confirmGiftCard(ctx, card, payment) {
  const { db, razorpay } = ctx;
  const cards = db.collection('giftCards');
  if (payment.order_id !== card.payment.razorpayOrderId) throw new HttpError(400, 'This payment is for another card');
  if (payment.amount !== card.amount) throw new HttpError(400, 'The payment amount does not match the card');
  if (payment.status === 'authorized') payment = await razorpay.capture(payment.id, payment.amount);
  if (payment.status !== 'captured') throw new HttpError(400, 'The payment did not go through. You can try again.');

  const now = new Date();
  const code = newCode();
  const later = card.sendAt > now;
  const sentAt = later ? null : now;
  const paid = await cards.findOneAndUpdate(
    { _id: card._id, status: 'awaiting_payment' },
    {
      $set: {
        status: later ? 'scheduled' : 'sent',
        'payment.status': 'paid',
        'payment.razorpayPaymentId': payment.id,
        'payment.paidAt': now,
        codeHash: codeHash(code),
        last4: normalCode(code).slice(-4),
        ...(later && { code }),
        sentAt,
        // A year from when the recipient gets it.
        expiresAt: new Date((later ? card.sendAt : now).getTime() + VALID_DAYS * DAY),
      },
      $unset: { payBy: '' },
    },
    { returnDocument: 'after' },
  );
  if (!paid) return cards.findOne({ _id: card._id });
  const buyer = await db.collection('users').findOne({ _id: paid.buyerId }, { projection: { name: 1, email: 1 } });
  try {
    if (buyer) {
      await ctx.mail.send({
        to: { email: buyer.email, name: buyer.name },
        ...giftCardReceiptEmail(paid, code, publicUrl(ctx)),
      });
    }
    if (!later) await sendRecipientEmail(ctx, paid, code);
  } catch (err) {
    console.error(`Could not email gift card ${paid._id}:`, err.message);
  }
  return paid;
}

// Run every minute: send the cards whose day has come. Each is claimed (status → sent, its code removed) before the
// email; a failed send puts it back for the next minute.
export async function sendScheduledGiftCards(ctx, now = new Date()) {
  const cards = ctx.db.collection('giftCards');
  const due = await cards
    .find({ status: 'scheduled', sendAt: { $lte: now } })
    .limit(20)
    .toArray();
  let sent = 0;
  for (const card of due) {
    const before = await cards.findOneAndUpdate(
      { _id: card._id, status: 'scheduled' },
      { $set: { status: 'sent', sentAt: now }, $unset: { code: '' } },
    );
    if (!before) continue;
    try {
      await sendRecipientEmail(ctx, before, before.code);
      sent += 1;
    } catch (err) {
      console.error(`Could not send gift card ${card._id}; trying again next minute:`, err.message);
      await cards.updateOne(
        { _id: card._id, status: 'sent' },
        { $set: { status: 'scheduled', code: before.code }, $unset: { sentAt: '' } },
      );
    }
  }
  return sent;
}

// Run every minute: one reminder to recipients whose card runs out within REMIND_DAYS, unredeemed.
export async function remindGiftCards(ctx, now = new Date()) {
  const cards = ctx.db.collection('giftCards');
  const due = await cards
    .find({
      status: 'sent',
      expiresAt: { $gt: now, $lte: new Date(now.getTime() + REMIND_DAYS * DAY) },
      reminderSentAt: { $exists: false },
    })
    .limit(20)
    .toArray();
  for (const card of due) {
    const claimed = await cards.findOneAndUpdate(
      { _id: card._id, reminderSentAt: { $exists: false } },
      { $set: { reminderSentAt: now } },
    );
    if (!claimed) continue;
    try {
      await ctx.mail.send({ to: card.recipient, ...giftCardReminderEmail(card, publicUrl(ctx)) });
    } catch (err) {
      console.error(`Could not remind about gift card ${card._id}:`, err.message);
    }
  }
  return due.length;
}

// Refunds a cancelled card's payment (claims it first, so it runs once). Failures stay as refund_failed for a retry.
async function refundGiftCard(ctx, card) {
  const cards = ctx.db.collection('giftCards');
  const claimed = await cards.findOneAndUpdate(
    { _id: card._id, status: 'cancelled', 'payment.status': { $in: ['paid', 'refund_failed'] } },
    { $set: { 'payment.status': 'refunding' } },
    { returnDocument: 'after' },
  );
  if (!claimed) return cards.findOne({ _id: card._id });
  let result;
  try {
    if (!ctx.razorpay) throw new Error('Online payments are not configured on this server');
    const refund = await ctx.razorpay.refund(claimed.payment.razorpayPaymentId, {
      amount: claimed.amount,
      notes: { giftCard: claimed._id.toString() },
    });
    result = {
      $set: { 'payment.status': 'refunded', 'payment.refundId': refund.id, 'payment.refundedAt': new Date() },
      $unset: { 'payment.refundError': '' },
    };
  } catch (err) {
    result = {
      $set: { 'payment.status': 'refund_failed', 'payment.refundError': refundErrorText(err, claimed.amount) },
    };
  }
  return cards.findOneAndUpdate({ _id: card._id }, result, { returnDocument: 'after' });
}

export function giftCardsRouter(ctx) {
  const { db, client, razorpay } = ctx;
  const cards = db.collection('giftCards');
  const router = express.Router();

  // What the page needs: whether cards can be bought, the amounts, and the cards this customer bought (if logged in).
  router.get('/gift-cards', async (req, res) => {
    const bought = req.user
      ? await cards
          .find({ buyerId: req.user._id, status: { $ne: 'awaiting_payment' } })
          .sort({ createdAt: -1 })
          .limit(50)
          .toArray()
      : [];
    res.json({
      available: Boolean(razorpay),
      amounts: AMOUNTS,
      validDays: VALID_DAYS,
      maxAheadDays: MAX_AHEAD_DAYS,
      bought: bought.map((c) => toGiftCard(c)),
    });
  });

  // Starts buying one: the card waits for its payment, which the browser makes in Razorpay's window.
  router.post('/gift-cards', requireUser, async (req, res) => {
    if (!razorpay) throw new HttpError(400, 'Gift cards can only be paid online, which isn’t available right now');
    const body = parse(buyBody, req.body);
    const now = new Date();
    const today = todayIst(now);
    if (body.sendOn && body.sendOn < today) throw new HttpError(400, 'sendOn: Choose today or a later day');
    if (body.sendOn && sendTime(body.sendOn) - now > (MAX_AHEAD_DAYS + 1) * DAY) {
      throw new HttpError(400, `sendOn: At most ${MAX_AHEAD_DAYS} days ahead`);
    }
    if (!(await takeHourlySlot(db, `giftCard:${req.user._id}`, BUYS_PER_HOUR))) {
      throw new HttpError(429, 'Too many gift cards this hour. Please try again later.');
    }
    const later = body.sendOn && body.sendOn > today ? sendTime(body.sendOn) : null;
    const card = {
      amount: body.amount,
      buyerId: req.user._id,
      buyerName: req.user.name,
      recipient: { name: body.recipientName, email: body.recipientEmail },
      message: body.message,
      sendAt: later ?? now,
      status: 'awaiting_payment',
      payment: { status: 'pending' },
      payBy: new Date(now.getTime() + UNPAID_DAYS * DAY),
      createdAt: now,
    };
    const { insertedId } = await cards.insertOne(card);
    const rzpOrder = await razorpay.createOrder({
      amount: card.amount,
      receipt: `gift_${insertedId}`,
      notes: { giftCard: insertedId.toString() },
    });
    await cards.updateOne({ _id: insertedId }, { $set: { 'payment.razorpayOrderId': rzpOrder.id } });
    res.status(201).json({
      ...toGiftCard({ ...card, _id: insertedId }),
      checkout: {
        keyId: razorpay.keyId,
        orderId: rzpOrder.id,
        amount: card.amount,
        currency: 'INR',
        prefill: { name: req.user.name, email: req.user.email },
      },
    });
  });

  // The browser reports the payment; only Razorpay's signature makes it count.
  router.post('/gift-cards/:id/payment', requireUser, async (req, res) => {
    const body = parse(paymentBody, req.body);
    const card = await cards.findOne({ _id: parseObjectId(req.params.id, 'gift card id'), buyerId: req.user._id });
    if (!card || !razorpay) throw new HttpError(404, 'Gift card not found');
    const genuine =
      body.razorpay_order_id === card.payment.razorpayOrderId &&
      razorpay.verifyPayment({
        orderId: card.payment.razorpayOrderId,
        paymentId: body.razorpay_payment_id,
        signature: body.razorpay_signature,
      });
    if (!genuine) throw new HttpError(400, 'The payment could not be verified');
    const payment = await razorpay.fetchPayment(body.razorpay_payment_id);
    res.json(toGiftCard(await confirmGiftCard(ctx, card, payment)));
  });

  // Turns a code into store credit. Wrong codes use up the hourly tries too, so codes can't be guessed.
  router.post('/gift-cards/redeem', requireUser, async (req, res) => {
    const { code } = parse(redeemBody, req.body);
    if (!(await takeHourlySlot(db, `giftRedeem:${req.user._id}`, REDEEMS_PER_HOUR))) {
      throw new HttpError(429, 'Too many tries this hour. Please try again later.');
    }
    const hash = codeHash(code);
    const now = new Date();
    const session = client.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        const card = await cards.findOneAndUpdate(
          { codeHash: hash, status: { $in: ['scheduled', 'sent'] }, expiresAt: { $gt: now } },
          { $set: { status: 'redeemed', redeemedBy: req.user._id, redeemedAt: now }, $unset: { code: '' } },
          { session, returnDocument: 'after' },
        );
        if (!card) {
          const found = await cards.findOne({ codeHash: hash }, { session });
          if (!found) throw new HttpError(404, 'That code isn’t right. Check it and try again.');
          if (found.status === 'redeemed') throw new HttpError(409, 'This gift card has already been used');
          if (found.status === 'cancelled') throw new HttpError(409, 'This gift card was cancelled');
          throw new HttpError(409, 'This gift card has run out');
        }
        const balance = await addCredit(
          db,
          req.user._id,
          card.amount,
          { reason: 'gift_card', note: `Gift card from ${card.buyerName}` },
          session,
        );
        result = { amount: card.amount, balance };
      });
    } finally {
      await session.endSession();
    }
    res.json(result);
  });

  // ---- Admin ----
  router.use('/admin/gift-cards', requireAdmin);

  router.get('/admin/gift-cards', async (req, res) => {
    const query = parse(adminQuery, req.query);
    const filter = query.status ? { status: query.status } : { status: { $ne: 'awaiting_payment' } };
    const [docs, total] = await Promise.all([
      cards
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * ADMIN_PAGE)
        .limit(ADMIN_PAGE)
        .toArray(),
      cards.countDocuments(filter),
    ]);
    const buyers = new Map(
      (
        await db
          .collection('users')
          .find({ _id: { $in: docs.map((d) => d.buyerId) } }, { projection: { email: 1 } })
          .toArray()
      ).map((u) => [u._id.toString(), u.email]),
    );
    res.json({
      items: docs.map((d) => ({
        ...toGiftCard(d),
        buyer: { id: d.buyerId.toString(), name: d.buyerName, email: buyers.get(d.buyerId.toString()) ?? null },
        payment: { status: d.payment.status, refundError: d.payment.refundError ?? null },
      })),
      total,
      page: query.page,
      pageSize: ADMIN_PAGE,
    });
  });

  // Cancels an unredeemed card and refunds the buyer (a mistake, a wrong email). Its code stops working at once.
  router.post('/admin/gift-cards/:id/cancel', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'gift card id');
    const card = await cards.findOneAndUpdate(
      { _id, status: { $in: ['scheduled', 'sent'] } },
      { $set: { status: 'cancelled', cancelledAt: new Date() }, $unset: { code: '' } },
      { returnDocument: 'after' },
    );
    if (!card) {
      const found = await cards.findOne({ _id });
      if (!found) throw new HttpError(404, 'Gift card not found');
      throw new HttpError(409, `This gift card is ${found.status === 'awaiting_payment' ? 'not paid' : found.status}`);
    }
    const after = await refundGiftCard(ctx, card);
    await logActivity(db, req.user, {
      area: 'giftCards',
      action: 'Cancelled gift card',
      target: {
        label: `${rupees(card.amount)} for ${card.recipient.email}`,
        path: '/admin/gift-cards?status=cancelled',
      },
      changes: [{ field: 'Refund', to: after.payment.status.replace('_', ' ') }],
    });
    const buyer = await db.collection('users').findOne({ _id: card.buyerId }, { projection: { name: 1, email: 1 } });
    if (buyer) {
      try {
        await ctx.mail.send({ to: { email: buyer.email, name: buyer.name }, ...giftCardCancelledEmail(after) });
      } catch (err) {
        console.error(`Could not email the cancelled gift card ${card._id}:`, err.message);
      }
    }
    res.json({
      ...toGiftCard(after),
      payment: { status: after.payment.status, refundError: after.payment.refundError ?? null },
    });
  });

  // Tries the refund of a cancelled card again after Razorpay refused it.
  router.post('/admin/gift-cards/:id/refund', async (req, res) => {
    const card = await cards.findOne({ _id: parseObjectId(req.params.id, 'gift card id') });
    if (!card) throw new HttpError(404, 'Gift card not found');
    if (card.payment.status !== 'refund_failed') throw new HttpError(409, 'Only a failed refund can be tried again');
    const after = await refundGiftCard(ctx, card);
    await logActivity(db, req.user, {
      area: 'giftCards',
      action: 'Retried gift card refund',
      target: {
        label: `${rupees(card.amount)} for ${card.recipient.email}`,
        path: '/admin/gift-cards?status=cancelled',
      },
      changes: [{ field: 'Refund', to: after.payment.status.replace('_', ' ') }],
    });
    res.json({
      ...toGiftCard(after),
      payment: { status: after.payment.status, refundError: after.payment.refundError ?? null },
    });
  });

  return router;
}
