import express from 'express';
import { z } from 'zod';
import { requirePermission } from './staff.js';
import { logActivity } from './activity.js';
import { HttpError, parse, parseObjectId } from './http.js';

// The store's FAQ (stage 130): questions and answers written by the store, by topic, on /faq and above the Help page's
// contact form. Collection `faqs` { question, answer, topic, position, active, createdAt, updatedAt }; `position`
// orders them within a topic. Admins and support staff (the `help` permission) write them; changes are logged in the
// activity log (area `help`). Answers are plain text; a blank line starts a new paragraph.
export const FAQ_TOPICS = {
  orders: 'Orders',
  delivery: 'Delivery',
  payment: 'Payment',
  returns: 'Returns and refunds',
  account: 'Your account',
  other: 'Other questions',
};
export const MAX_FAQS = 100;

const faqBody = z.object({
  question: z.string().trim().min(5, 'Write the question').max(150, 'Keep the question to 150 characters'),
  answer: z.string().trim().min(2, 'Write the answer').max(1500, 'Keep the answer to 1,500 characters'),
  topic: z.enum(Object.keys(FAQ_TOPICS), 'Choose a topic'),
  active: z.boolean().default(true),
});
const moveBody = z.object({ direction: z.enum(['up', 'down'], 'Say up or down') });

const toFaq = (doc, admin = false) => ({
  id: doc._id.toString(),
  question: doc.question,
  answer: doc.answer,
  topic: doc.topic,
  ...(admin && { active: doc.active, updatedAt: doc.updatedAt }),
});

// The entries grouped by topic, in FAQ_TOPICS order and each topic's own order; empty topics are left out.
function byTopic(docs, admin) {
  return Object.entries(FAQ_TOPICS)
    .map(([topic, label]) => ({
      topic,
      label,
      items: docs
        .filter((d) => d.topic === topic)
        .sort((a, b) => a.position - b.position)
        .map((d) => toFaq(d, admin)),
    }))
    .filter((g) => g.items.length);
}

export function faqRouter({ db }) {
  const router = express.Router();
  const faqs = db.collection('faqs');
  const target = (doc) => ({ label: doc.question, path: '/admin/faq' });

  router.get('/faq', async (req, res) => {
    res.json({ topics: byTopic(await faqs.find({ active: true }).toArray(), false) });
  });

  router.use('/admin/faq', requirePermission('help'));

  router.get('/admin/faq', async (req, res) => {
    const docs = await faqs.find().toArray();
    res.json({ topics: byTopic(docs, true), topicNames: FAQ_TOPICS, total: docs.length, max: MAX_FAQS });
  });

  router.post('/admin/faq', async (req, res) => {
    const body = parse(faqBody, req.body);
    if ((await faqs.countDocuments()) >= MAX_FAQS)
      throw new HttpError(409, `The FAQ holds at most ${MAX_FAQS} questions`);
    const [last] = await faqs.find({ topic: body.topic }).sort({ position: -1 }).limit(1).toArray();
    const now = new Date();
    const doc = { ...body, position: (last?.position ?? 0) + 1, createdAt: now, updatedAt: now };
    const { insertedId } = await faqs.insertOne(doc);
    await logActivity(db, req.user, { area: 'help', action: 'Added a FAQ', target: target(doc), changes: [] });
    res.status(201).json(toFaq({ ...doc, _id: insertedId }, true));
  });

  router.put('/admin/faq/:id', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'FAQ id');
    const body = parse(faqBody, req.body);
    const before = await faqs.findOne({ _id });
    if (!before) throw new HttpError(404, 'FAQ not found');
    // Moving to another topic puts it at the end of that topic.
    let position = before.position;
    if (body.topic !== before.topic) {
      const [last] = await faqs.find({ topic: body.topic }).sort({ position: -1 }).limit(1).toArray();
      position = (last?.position ?? 0) + 1;
    }
    const after = await faqs.findOneAndUpdate(
      { _id },
      { $set: { ...body, position, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    const changes = [];
    if (before.question !== after.question)
      changes.push({ field: 'Question', from: before.question, to: after.question });
    if (before.answer !== after.answer) changes.push({ field: 'Answer', to: 'edited' });
    if (before.topic !== after.topic) {
      changes.push({ field: 'Topic', from: FAQ_TOPICS[before.topic], to: FAQ_TOPICS[after.topic] });
    }
    if (before.active !== after.active) {
      changes.push({ field: 'Shown', from: before.active ? 'yes' : 'no', to: after.active ? 'yes' : 'no' });
    }
    if (changes.length) {
      await logActivity(db, req.user, { area: 'help', action: 'Edited a FAQ', target: target(after), changes });
    }
    res.json(toFaq(after, true));
  });

  // Swaps it with its neighbour in the same topic.
  router.post('/admin/faq/:id/move', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'FAQ id');
    const { direction } = parse(moveBody, req.body);
    const doc = await faqs.findOne({ _id });
    if (!doc) throw new HttpError(404, 'FAQ not found');
    const up = direction === 'up';
    const [other] = await faqs
      .find({ topic: doc.topic, position: up ? { $lt: doc.position } : { $gt: doc.position } })
      .sort({ position: up ? -1 : 1 })
      .limit(1)
      .toArray();
    if (other) {
      await faqs.updateOne({ _id: doc._id }, { $set: { position: other.position } });
      await faqs.updateOne({ _id: other._id }, { $set: { position: doc.position } });
    }
    res.status(204).end();
  });

  router.delete('/admin/faq/:id', async (req, res) => {
    const doc = await faqs.findOneAndDelete({ _id: parseObjectId(req.params.id, 'FAQ id') });
    if (!doc) throw new HttpError(404, 'FAQ not found');
    await logActivity(db, req.user, {
      area: 'help',
      action: 'Deleted a FAQ',
      target: { label: doc.question, path: null },
      changes: [],
    });
    res.status(204).end();
  });

  return router;
}
