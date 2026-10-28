import express from 'express';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { HttpError, parse, parseObjectId } from './http.js';
import { logActivity } from './activity.js';

// Announcements (stage 71): a short message across the top of the shop between two times, e.g. "Orders after 25 Oct
// ship after Diwali". Collection `announcements` { text, link (a page in the store) | null, startsAt, endsAt,
// createdBy, createdAt, updatedAt }. Several may be scheduled; while more than one is on, the one that started last
// shows. Ending one early sets its `endsAt` to now; they're never deleted, like coupons and sales.

export const MAX_TEXT = 160;
export const MAX_DAYS = 90;

// Only a page of the store ("/search?q=diwali", "/help"), never another site or "//host": the bar sits on every page.
const storePath = z
  .string()
  .trim()
  .max(200, 'At most 200 characters')
  .regex(/^\/(?!\/)\S*$/, 'A page of the store, starting with / (e.g. /help)');
const date = z.coerce.date('Enter a date and time');
const fields = {
  text: z.string().trim().min(5, 'Write the message').max(MAX_TEXT, `At most ${MAX_TEXT} characters`),
  link: z.union([z.literal(''), storePath]).optional(),
  startsAt: date,
  endsAt: date,
};
const checkDates = (schema) =>
  schema
    .refine((b) => !b.startsAt || !b.endsAt || b.endsAt > b.startsAt, {
      message: 'The end must be after the start',
      path: ['endsAt'],
    })
    .refine((b) => !b.startsAt || !b.endsAt || b.endsAt - b.startsAt <= MAX_DAYS * 86_400_000, {
      message: `At most ${MAX_DAYS} days`,
      path: ['endsAt'],
    });
const createBody = checkDates(z.object(fields));
const editBody = checkDates(z.object(fields).partial());

export function statusOf(doc, now = new Date()) {
  if (doc.endsAt <= now) return 'ended';
  return doc.startsAt <= now ? 'showing' : 'upcoming';
}

// What the shop shows now, or null.
export async function currentAnnouncement(db, now = new Date()) {
  const doc = await db
    .collection('announcements')
    .findOne({ startsAt: { $lte: now }, endsAt: { $gt: now } }, { sort: { startsAt: -1, _id: -1 } });
  return doc && { id: doc._id.toString(), text: doc.text, link: doc.link, endsAt: doc.endsAt };
}

const toAdmin = (doc, now) => ({
  id: doc._id.toString(),
  text: doc.text,
  link: doc.link,
  startsAt: doc.startsAt,
  endsAt: doc.endsAt,
  status: statusOf(doc, now),
});
const target = (doc) => ({
  label: `“${doc.text.length > 40 ? `${doc.text.slice(0, 40)}…` : doc.text}”`,
  path: '/admin/announcements',
});
const whenText = (d) => d.toISOString();

export function announcementsRouter({ db }) {
  const announcements = db.collection('announcements');
  const router = express.Router();

  // For every visitor; the bar asks once per page load.
  router.get('/announcement', async (req, res) => {
    res.json({ announcement: await currentAnnouncement(db) });
  });

  router.use('/admin/announcements', requireAdmin);

  router.get('/admin/announcements', async (req, res) => {
    const now = new Date();
    const docs = await announcements.find().sort({ startsAt: -1 }).limit(100).toArray();
    const showing = await currentAnnouncement(db, now);
    res.json({ items: docs.map((d) => ({ ...toAdmin(d, now), shown: d._id.toString() === showing?.id })) });
  });

  router.post('/admin/announcements', async (req, res) => {
    const body = parse(createBody, req.body);
    const now = new Date();
    if (body.endsAt <= now) throw new HttpError(400, 'endsAt: It would be over already');
    const doc = {
      text: body.text,
      link: body.link || null,
      startsAt: body.startsAt < now ? now : body.startsAt,
      endsAt: body.endsAt,
      createdBy: req.user._id,
      createdAt: now,
      updatedAt: now,
    };
    const { insertedId } = await announcements.insertOne(doc);
    await logActivity(db, req.user, {
      area: 'announcements',
      action: 'Scheduled announcement',
      target: target(doc),
      changes: [
        { field: 'Message', to: doc.text },
        ...(doc.link ? [{ field: 'Link', to: doc.link }] : []),
        { field: 'From', to: whenText(doc.startsAt) },
        { field: 'Until', to: whenText(doc.endsAt) },
      ],
    });
    res.status(201).json(toAdmin({ ...doc, _id: insertedId }, now));
  });

  // Changes the message, link or times of one that hasn't ended.
  router.patch('/admin/announcements/:id', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'announcement id');
    const body = parse(editBody, req.body);
    const now = new Date();
    const current = await announcements.findOne({ _id });
    if (!current) throw new HttpError(404, 'Announcement not found');
    if (current.endsAt <= now) throw new HttpError(409, 'This announcement is over');
    const next = {
      text: body.text ?? current.text,
      link: body.link === undefined ? current.link : body.link || null,
      startsAt: body.startsAt ?? current.startsAt,
      endsAt: body.endsAt ?? current.endsAt,
    };
    if (next.endsAt <= next.startsAt) throw new HttpError(400, 'endsAt: The end must be after the start');
    if (next.endsAt - next.startsAt > MAX_DAYS * 86_400_000)
      throw new HttpError(400, `endsAt: At most ${MAX_DAYS} days`);
    if (next.endsAt <= now) throw new HttpError(400, 'endsAt: It would be over already; use End now');
    const doc = await announcements.findOneAndUpdate(
      { _id, endsAt: { $gt: now } },
      { $set: { ...next, updatedAt: now } },
      { returnDocument: 'after' },
    );
    if (!doc) throw new HttpError(409, 'This announcement is over');
    const changes = [
      ['Message', current.text, doc.text],
      ['Link', current.link ?? '', doc.link ?? ''],
      ['From', whenText(current.startsAt), whenText(doc.startsAt)],
      ['Until', whenText(current.endsAt), whenText(doc.endsAt)],
    ]
      .filter(([, from, to]) => from !== to)
      .map(([field, from, to]) => ({ field, from, to }));
    if (changes.length) {
      await logActivity(db, req.user, {
        area: 'announcements',
        action: 'Changed announcement',
        target: target(doc),
        changes,
      });
    }
    res.json(toAdmin(doc, now));
  });

  // Takes one down now, or calls off one that hasn't started.
  router.post('/admin/announcements/:id/end', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'announcement id');
    const now = new Date();
    const before = await announcements.findOneAndUpdate({ _id, endsAt: { $gt: now } }, [
      { $set: { endsAt: now, updatedAt: now, startsAt: { $min: ['$startsAt', now] } } },
    ]);
    if (!before) {
      if (!(await announcements.findOne({ _id }, { projection: { _id: 1 } }))) {
        throw new HttpError(404, 'Announcement not found');
      }
      throw new HttpError(409, 'This announcement is over');
    }
    await logActivity(db, req.user, {
      area: 'announcements',
      action: before.startsAt <= now ? 'Took down announcement' : 'Called off announcement',
      target: target(before),
    });
    res.json(toAdmin(await announcements.findOne({ _id }), now));
  });

  return router;
}
