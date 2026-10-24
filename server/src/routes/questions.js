import express from 'express';
import { z } from 'zod';
import { requireAdmin, requireUser } from '../auth.js';
import { sendQuestionAnswered } from '../emails.js';
import { HttpError, parse, parseObjectId } from '../http.js';
import { logActivity } from '../activity.js';
import { takeHourlySlot } from '../rateLimit.js';
import { shortName } from './reviews.js';

// Questions on products (collection `questions`): logged-in customers ask, admins answer. Only answered questions are
// shown on the product page; until then only the asker sees theirs ("waiting for an answer") and may delete it. The
// asker is emailed when it is first answered. Admins can hide a question (spam), which also takes it off the page.
// { productId, userId, author ("Asha R."), text, createdAt, answer: { text, by, at, updatedAt } | null, hidden }

const QUESTION_PAGE = 10;
const ADMIN_PAGE = 25;
export const QUESTIONS_PER_HOUR = 5;
const MAX_PENDING = 20; // unanswered questions one customer can have open across the store

const questionBody = z.object({
  text: z.string().trim().min(5, 'Write your question (at least 5 characters)').max(500, 'At most 500 characters'),
});
const answerBody = z.object({
  text: z.string().trim().min(1, 'Write the answer').max(2000, 'At most 2000 characters'),
});
const listQuery = z.object({ page: z.coerce.number().int().min(1).max(1000).default(1) });
const adminQuery = z.object({
  status: z.enum(['unanswered', 'answered', 'hidden']).default('unanswered'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
const visibilityBody = z.object({ hidden: z.boolean() });

const toQuestion = (doc) => ({
  id: doc._id.toString(),
  text: doc.text,
  author: doc.author,
  createdAt: doc.createdAt,
  answer: doc.answer ? { text: doc.answer.text, at: doc.answer.at } : null,
});

// For the dashboard's "needs attention": questions waiting for an answer.
export const UNANSWERED = { answer: null, hidden: false };

export function questionsRouter(ctx) {
  const { db } = ctx;
  const products = db.collection('products');
  const questions = db.collection('questions');
  const router = express.Router();

  async function findProduct(slug) {
    const product = await products.findOne({ slug, active: true }, { projection: { _id: 1, title: 1, slug: 1 } });
    if (!product) throw new HttpError(404, 'Product not found');
    return product;
  }

  // Answered questions, newest answer first; for a logged-in visitor also their own that wait for an answer.
  router.get('/products/:slug/questions', async (req, res) => {
    const { page } = parse(listQuery, req.query);
    const { _id: productId } = await findProduct(req.params.slug);
    const filter = { productId, hidden: false, answer: { $ne: null } };
    const [docs, total, mine] = await Promise.all([
      questions
        .find(filter)
        .sort({ 'answer.at': -1, _id: -1 })
        .skip((page - 1) * QUESTION_PAGE)
        .limit(QUESTION_PAGE)
        .toArray(),
      questions.countDocuments(filter),
      req.user
        ? questions
            .find({ productId, userId: req.user._id, answer: null, hidden: false })
            .sort({ createdAt: -1 })
            .toArray()
        : [],
    ]);
    res.json({ items: docs.map(toQuestion), total, page, pageSize: QUESTION_PAGE, waiting: mine.map(toQuestion) });
  });

  router.post('/products/:slug/questions', requireUser, async (req, res) => {
    const { text } = parse(questionBody, req.body);
    const product = await findProduct(req.params.slug);
    const userId = req.user._id;
    if ((await questions.countDocuments({ userId, ...UNANSWERED })) >= MAX_PENDING) {
      throw new HttpError(429, `You have ${MAX_PENDING} questions waiting for an answer. Please wait for those first.`);
    }
    if (!(await takeHourlySlot(db, `question:${userId}`, QUESTIONS_PER_HOUR))) {
      throw new HttpError(429, `You can ask ${QUESTIONS_PER_HOUR} questions an hour. Please try again later.`);
    }
    const doc = {
      productId: product._id,
      userId,
      author: shortName(req.user.name),
      text,
      createdAt: new Date(),
      answer: null,
      hidden: false,
    };
    const { insertedId } = await questions.insertOne(doc);
    res.status(201).json(toQuestion({ ...doc, _id: insertedId }));
  });

  // The asker can take back a question nobody has answered yet.
  router.delete('/questions/:id', requireUser, async (req, res) => {
    const _id = parseObjectId(req.params.id, 'question id');
    const { deletedCount } = await questions.deleteOne({ _id, userId: req.user._id, answer: null });
    if (!deletedCount) {
      const existing = await questions.findOne({ _id, userId: req.user._id });
      if (!existing) throw new HttpError(404, 'Question not found');
      throw new HttpError(409, 'This question has been answered, so it stays on the product page');
    }
    res.status(204).end();
  });

  // ---- Admin ----
  router.use('/admin/questions', requireAdmin);

  // With the product's title and the asker's full name and email, which customers never see.
  async function adminView(docs) {
    const [items, people] = await Promise.all([
      products
        .find({ _id: { $in: docs.map((q) => q.productId) } }, { projection: { title: 1, slug: 1, active: 1 } })
        .toArray(),
      db
        .collection('users')
        .find({ _id: { $in: docs.map((q) => q.userId) } }, { projection: { name: 1, email: 1 } })
        .toArray(),
    ]);
    const product = new Map(items.map((p) => [p._id.toString(), { title: p.title, slug: p.slug, active: p.active }]));
    const person = new Map(people.map((u) => [u._id.toString(), { name: u.name, email: u.email }]));
    return docs.map((q) => ({
      ...toQuestion(q),
      hidden: q.hidden,
      product: product.get(q.productId.toString()) ?? null,
      customer: person.get(q.userId.toString()) ?? null,
    }));
  }

  // Unanswered (oldest first, so nobody waits longest), answered or hidden (newest first), with a count of each.
  router.get('/admin/questions', async (req, res) => {
    const { status, page } = parse(adminQuery, req.query);
    const filters = {
      unanswered: UNANSWERED,
      answered: { answer: { $ne: null }, hidden: false },
      hidden: { hidden: true },
    };
    const sort = status === 'unanswered' ? { createdAt: 1, _id: 1 } : { createdAt: -1, _id: -1 };
    const [docs, total, ...counts] = await Promise.all([
      questions
        .find(filters[status])
        .sort(sort)
        .skip((page - 1) * ADMIN_PAGE)
        .limit(ADMIN_PAGE)
        .toArray(),
      questions.countDocuments(filters[status]),
      ...Object.values(filters).map((f) => questions.countDocuments(f)),
    ]);
    res.json({
      items: await adminView(docs),
      total,
      page,
      pageSize: ADMIN_PAGE,
      counts: Object.fromEntries(Object.keys(filters).map((k, i) => [k, counts[i]])),
    });
  });

  // Answers a question, or changes the answer. The asker is emailed the first time only.
  router.put('/admin/questions/:id/answer', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'question id');
    const { text } = parse(answerBody, req.body);
    const now = new Date();
    const before = await questions.findOneAndUpdate(
      { _id },
      [
        {
          $set: {
            answer: {
              // $literal: an answer starting with $ ("$5 cheaper") would otherwise be read as a field path.
              text: { $literal: text },
              by: req.user._id,
              // When it was first answered (the page's order); edits only move updatedAt.
              at: { $ifNull: ['$answer.at', now] },
              updatedAt: now,
            },
          },
        },
      ],
      { returnDocument: 'before' },
    );
    if (!before) throw new HttpError(404, 'Question not found');
    const doc = await questions.findOne({ _id });
    const [view] = await adminView([doc]);
    await logActivity(db, req.user, {
      area: 'questions',
      action: before.answer ? 'Changed answer' : 'Answered question',
      target: {
        label: `${view.product?.title ?? 'A product'}: “${doc.text}”`,
        path: '/admin/questions?status=answered',
      },
      changes: [{ field: 'Answer', ...(before.answer && { from: before.answer.text }), to: text }],
    });
    if (!before.answer && !doc.hidden) await sendQuestionAnswered(ctx, doc, view.product);
    res.json(view);
  });

  router.post('/admin/questions/:id/visibility', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'question id');
    const { hidden } = parse(visibilityBody, req.body);
    const before = await questions.findOneAndUpdate({ _id }, { $set: { hidden } }, { returnDocument: 'before' });
    if (!before) throw new HttpError(404, 'Question not found');
    const [view] = await adminView([{ ...before, hidden }]);
    if (before.hidden !== hidden) {
      await logActivity(db, req.user, {
        area: 'questions',
        action: hidden ? 'Hid question' : 'Showed question',
        target: {
          label: `${view.product?.title ?? 'A product'}: “${before.text}”`,
          path: '/admin/questions?status=hidden',
        },
      });
    }
    res.json(view);
  });

  return router;
}
