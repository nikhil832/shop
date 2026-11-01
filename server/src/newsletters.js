import express from 'express';
import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { logActivity } from './activity.js';
import { newsEmail } from './emails.js';
import { HttpError, parse, parseObjectId } from './http.js';
import { takeDailyCall, takeHourlySlot, usedToday } from './rateLimit.js';
import { TAGS } from './customerTags.js';
import { LEVELS, loyaltySettings, spentInYear } from './loyalty.js';

// Store news emails (stage 140): admins write a short email (`newsletters`) and send it to customers who opted in
// (`users.newsEmails: true`, off unless they tick it on the account page). Sending queues one `newsletterSends`
// { newsletterId, userId, status: pending | sent | failed | skipped, at } per subscriber; the minute sweep
// (sendNewsletters) works through the queue, at most DAILY_LIMIT a day (India time) so Brevo's free 300 leave room
// for order emails, and checks the subscription again at send time. Every email carries an unsubscribe link (a page
// with a button, so mail scanners opening links don't unsubscribe anyone) and the one-click List-Unsubscribe header;
// both use `users.newsToken`, made when a customer first opts in.
export const DAILY_LIMIT = 250;
const BATCH = 20; // per sweep
const DAILY_ID = 'newsEmailsDaily';
const TESTS_PER_HOUR = 10;
const TOKEN = /^[\w-]{20,40}$/;

export const newToken = () => randomBytes(18).toString('base64url');

const storePath = z
  .string()
  .trim()
  .max(200)
  .refine((p) => /^\/(?!\/)\S*$/.test(p), 'link: Use a page of the store, starting with /, like /search?deals=1');
// Groups (stage 143): who among the subscribers gets an email. 'all'; 'loyalty:silver' (Silver and Gold) or
// 'loyalty:gold', while loyalty levels are on; 'tag:<TAGS key>'; 'category:<id>' (customers with a sold order of a
// product in it). Worked out when counting and again when sending; the label is kept with the email.
const GROUP = new RegExp(`^(all|loyalty:(silver|gold)|tag:(${Object.keys(TAGS).join('|')})|category:[0-9a-f]{24})$`);
const groupField = z.string().regex(GROUP, 'group: Choose who gets it').default('all');
// The same as SOLD in routes/dashboard.js (not imported: it leads back here through the dashboard).
const SOLD = ['placed', 'shipped', 'delivered'];

// { ids, label }: the subscribers in `group` (400 for an unknown category, 409 for loyalty while it's off).
export async function groupMembers(db, group) {
  const subscribed = { newsEmails: true };
  const users = db.collection('users');
  const idsOf = async (filter) =>
    (await users.find({ ...subscribed, ...filter }, { projection: { _id: 1 } }).toArray()).map((u) => u._id);
  const [kind, value] = group.split(':');
  if (kind === 'all') return { ids: await idsOf({}), label: 'Everyone subscribed' };
  if (kind === 'tag') return { ids: await idsOf({ tags: value }), label: `Customers tagged ${TAGS[value]}` };
  if (kind === 'category') {
    const category = await db.collection('categories').findOne({ _id: new ObjectId(value) });
    if (!category) throw new HttpError(400, 'group: That category no longer exists');
    const productIds = await db.collection('products').distinct('_id', { categoryId: category._id });
    const buyers = await db
      .collection('orders')
      .distinct('userId', { status: { $in: SOLD }, 'items.productId': { $in: productIds } });
    return { ids: await idsOf({ _id: { $in: buyers } }), label: `Customers who bought from ${category.name}` };
  }
  const settings = await loyaltySettings(db);
  if (!settings.enabled) throw new HttpError(409, 'Loyalty levels are switched off, so nobody has a level');
  const spend = settings[value].spend;
  const ids = [];
  for (const id of await idsOf({})) if ((await spentInYear(db, id)) >= spend) ids.push(id);
  return {
    ids,
    label: value === 'gold' ? `${LEVELS.gold} members` : `${LEVELS.silver} and ${LEVELS.gold} members`,
  };
}

const letterBody = z.object({
  subject: z.string().trim().min(3, 'subject: Write a subject').max(120, 'subject: At most 120 characters'),
  body: z.string().trim().min(10, 'body: Write the email').max(5000, 'body: At most 5,000 characters'),
  link: z.union([storePath, z.literal('')]).default(''),
  linkText: z.string().trim().max(30, 'linkText: At most 30 characters').default(''),
  group: groupField,
});

const toLetter = (doc) => ({
  id: doc._id.toString(),
  subject: doc.subject,
  body: doc.body,
  link: doc.link ?? '',
  linkText: doc.linkText ?? '',
  // Who gets it (stage 143); emails from before groups went to everyone.
  group: doc.group ?? 'all',
  groupLabel: doc.groupLabel ?? 'Everyone subscribed',
  status: doc.status,
  by: doc.by?.name ?? null,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
  queuedAt: doc.queuedAt ?? null,
  sentAt: doc.sentAt ?? null,
  recipients: doc.recipients ?? 0,
  sent: doc.sent ?? 0,
  failed: doc.failed ?? 0,
});

// The email for `user` (who has a token) or, for a test, without one (the link goes to the account page).
function emailFor(letter, user, publicUrl) {
  const unsubscribeUrl = user.newsToken
    ? `${publicUrl}/unsubscribe#token=${user.newsToken}`
    : `${publicUrl}/account#updates`;
  const mail = newsEmail(user, letter, unsubscribeUrl, publicUrl);
  return user.newsToken
    ? {
        ...mail,
        headers: {
          'List-Unsubscribe': `<${publicUrl}/api/news/unsubscribe?token=${user.newsToken}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }
    : mail;
}

// Run every minute: sends up to BATCH queued emails within the day's limit, then marks finished newsletters sent.
// Returns how many it sent.
export async function sendNewsletters(ctx, now = new Date()) {
  const { db } = ctx;
  const sends = db.collection('newsletterSends');
  const letters = db.collection('newsletters');
  const publicUrl = ctx.config.mail?.publicUrl ?? 'http://localhost:5173';
  let sent = 0;
  const queued = await sends.find({ status: 'pending' }).sort({ _id: 1 }).limit(BATCH).toArray();
  const cache = new Map();
  for (const item of queued) {
    // Claimed first, so two sweeps never send the same one.
    const claimed = await sends.findOneAndUpdate(
      { _id: item._id, status: 'pending' },
      { $set: { status: 'sending', at: now } },
    );
    if (!claimed) continue;
    const user = await db
      .collection('users')
      .findOne({ _id: item.userId }, { projection: { name: 1, email: 1, newsEmails: 1, newsToken: 1 } });
    if (!user || user.newsEmails !== true || !user.newsToken) {
      await sends.updateOne({ _id: item._id }, { $set: { status: 'skipped', at: now } });
      continue;
    }
    if (!(await takeDailyCall(db, DAILY_ID, DAILY_LIMIT, now))) {
      await sends.updateOne({ _id: item._id }, { $set: { status: 'pending' }, $unset: { at: '' } });
      break; // the rest wait for tomorrow
    }
    const key = item.newsletterId.toString();
    if (!cache.has(key)) cache.set(key, await letters.findOne({ _id: item.newsletterId }));
    const letter = cache.get(key);
    let status = 'sent';
    try {
      await ctx.mail.send({ to: { email: user.email, name: user.name }, ...emailFor(letter, user, publicUrl) });
      sent += 1;
    } catch (err) {
      status = 'failed';
      console.error(`Could not send store news ${key} to ${user._id}:`, err.message);
    }
    await sends.updateOne({ _id: item._id }, { $set: { status, at: now } });
    await letters.updateOne({ _id: item.newsletterId }, { $inc: { [status]: 1 } });
  }
  // Newsletters with nothing left in the queue are done.
  for (const letter of await letters.find({ status: 'sending' }, { projection: { _id: 1 } }).toArray()) {
    const left = await sends.countDocuments({ newsletterId: letter._id, status: { $in: ['pending', 'sending'] } });
    if (!left)
      await letters.updateOne({ _id: letter._id, status: 'sending' }, { $set: { status: 'sent', sentAt: now } });
  }
  return sent;
}

export function newsletterRouter(ctx) {
  const { db } = ctx;
  const letters = db.collection('newsletters');
  const sends = db.collection('newsletterSends');
  const users = db.collection('users');
  const router = express.Router();
  const publicUrl = () => ctx.config.mail?.publicUrl ?? 'http://localhost:5173';

  // Unsubscribing: the email's page (a button) and mail apps' one-click (RFC 8058) both POST here with the token in
  // the address; nothing happens on a GET, which scanners do.
  router.post('/news/unsubscribe', async (req, res) => {
    const token = String(req.query.token ?? '');
    if (!TOKEN.test(token)) throw new HttpError(404, 'This unsubscribe link is not valid');
    const user = await users.findOneAndUpdate({ newsToken: token }, { $set: { newsEmails: false } });
    if (!user) throw new HttpError(404, 'This unsubscribe link is not valid');
    await sends.updateMany({ userId: user._id, status: 'pending' }, { $set: { status: 'skipped' } });
    res.json({ unsubscribed: true });
  });

  router.use('/admin/newsletters', requireAdmin);

  router.get('/admin/newsletters', async (req, res) => {
    const [items, subscribers, daily] = await Promise.all([
      letters.find().sort({ createdAt: -1 }).limit(50).toArray(),
      users.countDocuments({ newsEmails: true }),
      db.collection('settings').findOne({ _id: DAILY_ID }),
    ]);
    res.json({ items: items.map(toLetter), subscribers, dailyLimit: DAILY_LIMIT, sentToday: usedToday(daily) });
  });

  // How many subscribers a group has now, for the form.
  router.get('/admin/newsletters/group', async (req, res) => {
    const { group } = parse(z.object({ group: groupField }), req.query);
    const { ids, label } = await groupMembers(db, group);
    res.json({ group, label, count: ids.length });
  });

  router.post('/admin/newsletters', async (req, res) => {
    const body = parse(letterBody, req.body);
    const { label } = await groupMembers(db, body.group);
    const now = new Date();
    const doc = {
      ...body,
      groupLabel: label,
      status: 'draft',
      by: { id: req.user._id, name: req.user.name },
      createdAt: now,
      updatedAt: now,
    };
    const { insertedId } = await letters.insertOne(doc);
    res.status(201).json(toLetter({ _id: insertedId, ...doc }));
  });

  const findDraft = async (id) => {
    const doc = await letters.findOne({ _id: parseObjectId(id, 'newsletter id') });
    if (!doc) throw new HttpError(404, 'Newsletter not found');
    if (doc.status !== 'draft') throw new HttpError(409, 'This email has already been sent');
    return doc;
  };

  router.put('/admin/newsletters/:id', async (req, res) => {
    const body = parse(letterBody, req.body);
    const doc = await findDraft(req.params.id);
    const { label } = await groupMembers(db, body.group);
    const after = await letters.findOneAndUpdate(
      { _id: doc._id, status: 'draft' },
      { $set: { ...body, groupLabel: label, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!after) throw new HttpError(409, 'This email has already been sent');
    res.json(toLetter(after));
  });

  router.delete('/admin/newsletters/:id', async (req, res) => {
    const doc = await findDraft(req.params.id);
    await letters.deleteOne({ _id: doc._id, status: 'draft' });
    res.status(204).end();
  });

  // A copy to the asking admin only, now; doesn't count towards the daily limit or touch the queue.
  router.post('/admin/newsletters/:id/test', async (req, res) => {
    const doc = await letters.findOne({ _id: parseObjectId(req.params.id, 'newsletter id') });
    if (!doc) throw new HttpError(404, 'Newsletter not found');
    if (!(await takeHourlySlot(db, `newsTest:${req.user._id}`, TESTS_PER_HOUR))) {
      throw new HttpError(429, `At most ${TESTS_PER_HOUR} test emails an hour`);
    }
    const mail = emailFor(doc, { name: req.user.name, email: req.user.email }, publicUrl());
    try {
      await ctx.mail.send({
        to: { email: req.user.email, name: req.user.name },
        ...mail,
        subject: `[Test] ${mail.subject}`,
      });
    } catch (err) {
      console.error('Could not send a test of store news:', err.message);
      throw new HttpError(502, "The test email couldn't be sent. Try again in a minute", { expose: true });
    }
    res.json({ sentTo: req.user.email });
  });

  // Queues the draft for its group's subscribers now; the sweep sends it.
  router.post('/admin/newsletters/:id/send', async (req, res) => {
    const doc = await findDraft(req.params.id);
    const group = doc.group ?? 'all';
    const { ids, label } = await groupMembers(db, group);
    const subscribers = ids.map((_id) => ({ _id }));
    if (!subscribers.length) {
      throw new HttpError(
        409,
        group === 'all' ? 'Nobody has asked for store news yet' : 'Nobody in this group has asked for store news',
      );
    }
    const now = new Date();
    const claimed = await letters.findOneAndUpdate(
      { _id: doc._id, status: 'draft' },
      {
        $set: {
          status: 'sending',
          queuedAt: now,
          groupLabel: label,
          recipients: subscribers.length,
          sent: 0,
          failed: 0,
        },
      },
      { returnDocument: 'after' },
    );
    if (!claimed) throw new HttpError(409, 'This email has already been sent');
    await sends.insertMany(
      subscribers.map((u) => ({ _id: new ObjectId(), newsletterId: doc._id, userId: u._id, status: 'pending' })),
      { ordered: false },
    );
    await logActivity(db, req.user, {
      area: 'news',
      action: 'Sent store news',
      target: { label: doc.subject, path: '/admin/news' },
      changes: [
        { field: 'Sent to', to: label },
        { field: 'Subscribers', to: String(subscribers.length) },
      ],
    });
    res.json(toLetter(claimed));
  });

  return router;
}
