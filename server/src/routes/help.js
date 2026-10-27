import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { clientIp, hashToken, networkOf, requireAdmin, requireUser } from '../auth.js';
import { logActivity } from '../activity.js';
import { helpReplyEmail, helpRequestEmail, sendToAdmins } from '../emails.js';
import { HttpError, parse, parseObjectId } from '../http.js';
import { takeHourlySlot } from '../rateLimit.js';
import { email } from './auth.js';

// Help requests (stage 64): customers (logged in or not) write to the store from the Help page or about one of their
// orders; admins answer in Admin → Help and the customer is emailed. Collection `helpRequests`:
// { number, userId | null, name, email, topic, orderId | null, status, messages: [{ from: 'customer' | 'store', by,
//   text, at }], createdAt, updatedAt }. Status: 'waiting' (the customer wrote last), 'answered' (the store did) or
// 'closed'; a customer writing to a closed one opens it again. Guests get replies by email only; logged-in customers
// also see the thread on the Help page. Numbers come from the `counters` document `helpNumber`.

export const TOPICS = {
  order: 'An order',
  product: 'A product',
  payment: 'Payment or refund',
  account: 'My account',
  other: 'Something else',
};
export const NEW_PER_HOUR = 5; // new requests per visitor network
export const MAX_OPEN = 10; // open requests per account
const MAX_MESSAGES = 50;
const ADMIN_PAGE = 25;

const text = z.string().trim().min(5, 'Write at least a few words').max(2000, 'At most 2000 characters');
const newBody = z.object({
  topic: z.enum(Object.keys(TOPICS), 'Choose what it is about'),
  message: text,
  orderId: z
    .string()
    .regex(/^[0-9a-f]{24}$/)
    .optional(),
  // Only for visitors who aren't logged in.
  name: z.string().trim().min(1, 'Enter your name').max(80).optional(),
  email: email.optional(),
});
const messageBody = z.object({ text });
const statusBody = z.object({ status: z.enum(['open', 'closed']) });
const adminQuery = z.object({
  status: z.enum(['waiting', 'answered', 'closed']).default('waiting'),
  orderId: z
    .string()
    .regex(/^[0-9a-f]{24}$/)
    .optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

// For the dashboard's "needs attention".
export const WAITING = { status: 'waiting' };

const toRequest = (doc) => ({
  id: doc._id.toString(),
  number: doc.number,
  topic: doc.topic,
  orderId: doc.orderId?.toString() ?? null,
  status: doc.status,
  messages: doc.messages.map((m) => ({
    from: m.from,
    by: m.from === 'store' ? (m.by?.name ?? 'Bazaar') : null,
    text: m.text,
    at: m.at,
  })),
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

export function helpRouter(ctx) {
  const { db, config } = ctx;
  const requests = db.collection('helpRequests');
  const orders = db.collection('orders');
  const router = express.Router();
  const publicUrl = () => config.mail?.publicUrl;

  // A new request. Logged in: from the account (and about one of their orders, if given). Not logged in: name and email.
  router.post('/help', async (req, res) => {
    const body = parse(newBody, req.body);
    const user = req.user;
    if (!user && (!body.name || !body.email)) throw new HttpError(400, 'Enter your name and email so we can reply');
    if (!user && body.orderId) throw new HttpError(401, 'Log in to ask about an order');
    let order = null;
    if (body.orderId) {
      order = await orders.findOne(
        { _id: new ObjectId(body.orderId), userId: user._id },
        { projection: { number: 1 } },
      );
      if (!order) throw new HttpError(404, 'Order not found');
    }
    if (user && (await requests.countDocuments({ userId: user._id, status: { $ne: 'closed' } })) >= MAX_OPEN) {
      throw new HttpError(429, `You have ${MAX_OPEN} open requests. We'll answer those first.`);
    }
    const network = networkOf(clientIp(req, config));
    if (!(await takeHourlySlot(db, `help:${hashToken(network)}`, NEW_PER_HOUR))) {
      throw new HttpError(429, 'Too many requests from here this hour. Please try again later.');
    }
    const counter = await db
      .collection('counters')
      .findOneAndUpdate({ _id: 'helpNumber' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
    const now = new Date();
    const doc = {
      number: counter.seq,
      userId: user?._id ?? null,
      name: user?.name ?? body.name,
      email: user?.email ?? body.email,
      topic: body.topic,
      orderId: order?._id ?? null,
      status: 'waiting',
      messages: [{ from: 'customer', by: null, text: body.message, at: now }],
      createdAt: now,
      updatedAt: now,
    };
    const { insertedId } = await requests.insertOne(doc);
    await sendToAdmins(
      ctx,
      helpRequestEmail({ ...doc, _id: insertedId }, order, false, publicUrl()),
      'a help request alert',
    );
    res.status(201).json(toRequest({ ...doc, _id: insertedId }));
  });

  // The logged-in customer's own requests, newest first.
  router.get('/help', requireUser, async (req, res) => {
    const docs = await requests.find({ userId: req.user._id }).sort({ updatedAt: -1 }).limit(100).toArray();
    res.json({ items: docs.map(toRequest) });
  });

  async function ownRequest(req) {
    const doc = await requests.findOne({ _id: parseObjectId(req.params.id, 'request id'), userId: req.user._id });
    if (!doc) throw new HttpError(404, 'Help request not found');
    return doc;
  }

  router.get('/help/:id', requireUser, async (req, res) => {
    res.json(toRequest(await ownRequest(req)));
  });

  // The customer writes again: it waits for the store (a closed one opens again).
  router.post('/help/:id/messages', requireUser, async (req, res) => {
    const { text: message } = parse(messageBody, req.body);
    const before = await ownRequest(req);
    const now = new Date();
    const doc = await requests.findOneAndUpdate(
      { _id: before._id, [`messages.${MAX_MESSAGES - 1}`]: { $exists: false } },
      {
        $push: { messages: { from: 'customer', by: null, text: message, at: now } },
        $set: { status: 'waiting', updatedAt: now },
      },
      { returnDocument: 'after' },
    );
    if (!doc) throw new HttpError(409, 'This conversation is full. Please start a new request.');
    const order = doc.orderId && (await orders.findOne({ _id: doc.orderId }, { projection: { number: 1 } }));
    await sendToAdmins(ctx, helpRequestEmail(doc, order, true, publicUrl()), 'a help request alert');
    res.json(toRequest(doc));
  });

  // ---- Admin ----
  router.use('/admin/help', requireAdmin);

  // Waiting (oldest first, so nobody waits longest), answered or closed (newest first), with a count of each; or all
  // of one order's.
  router.get('/admin/help', async (req, res) => {
    const { status, orderId, page } = parse(adminQuery, req.query);
    const filter = orderId ? { orderId: new ObjectId(orderId) } : { status };
    const sort = status === 'waiting' && !orderId ? { updatedAt: 1, _id: 1 } : { updatedAt: -1, _id: -1 };
    const [docs, total, counts] = await Promise.all([
      requests
        .find(filter)
        .sort(sort)
        .skip((page - 1) * ADMIN_PAGE)
        .limit(ADMIN_PAGE)
        .toArray(),
      requests.countDocuments(filter),
      requests.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    ]);
    const numbers = new Map(
      (
        await orders
          .find({ _id: { $in: docs.map((d) => d.orderId).filter(Boolean) } }, { projection: { number: 1 } })
          .toArray()
      ).map((o) => [o._id.toString(), o.number ?? o._id.toString().slice(-8).toUpperCase()]),
    );
    res.json({
      items: docs.map((d) => ({
        ...toRequest(d),
        customer: { name: d.name, email: d.email, guest: !d.userId },
        orderNumber: d.orderId ? (numbers.get(d.orderId.toString()) ?? null) : null,
      })),
      total,
      page,
      pageSize: ADMIN_PAGE,
      counts: Object.fromEntries(
        ['waiting', 'answered', 'closed'].map((s) => [s, counts.find((c) => c._id === s)?.n ?? 0]),
      ),
    });
  });

  // A reply from the store: emailed to the customer, and the request is answered.
  router.post('/admin/help/:id/reply', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'request id');
    const { text: message } = parse(messageBody, req.body);
    const now = new Date();
    const doc = await requests.findOneAndUpdate(
      { _id, [`messages.${MAX_MESSAGES - 1}`]: { $exists: false } },
      {
        $push: { messages: { from: 'store', by: { id: req.user._id, name: req.user.name }, text: message, at: now } },
        $set: { status: 'answered', updatedAt: now },
      },
      { returnDocument: 'after' },
    );
    if (!doc) {
      if (await requests.findOne({ _id }, { projection: { _id: 1 } })) {
        throw new HttpError(409, 'This conversation is full. Ask the customer to start a new request.');
      }
      throw new HttpError(404, 'Help request not found');
    }
    try {
      await ctx.mail.send({ to: { email: doc.email, name: doc.name }, ...helpReplyEmail(doc, message, publicUrl()) });
    } catch (err) {
      console.error(`Could not email the reply to help request ${doc.number}:`, err.message);
    }
    await logActivity(db, req.user, {
      area: 'help',
      action: 'Answered help request',
      target: { label: `Request #${doc.number} from ${doc.name}`, path: '/admin/help?status=answered' },
    });
    res.json(toRequest(doc));
  });

  // Closes a request, or opens it again (as waiting). Only a real change is logged.
  router.post('/admin/help/:id/status', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'request id');
    const { status } = parse(statusBody, req.body);
    const closing = status === 'closed';
    const doc = await requests.findOneAndUpdate(
      { _id, status: closing ? { $ne: 'closed' } : 'closed' },
      { $set: { status: closing ? 'closed' : 'waiting', updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (doc) {
      await logActivity(db, req.user, {
        area: 'help',
        action: closing ? 'Closed help request' : 'Reopened help request',
        target: { label: `Request #${doc.number} from ${doc.name}`, path: `/admin/help?status=${doc.status}` },
      });
      return res.json(toRequest(doc));
    }
    const existing = await requests.findOne({ _id });
    if (!existing) throw new HttpError(404, 'Help request not found');
    res.json(toRequest(existing));
  });

  return router;
}
