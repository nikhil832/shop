import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { requirePermission } from '../staff.js';
import { sendQuestionAnswered } from '../emails.js';
import { HttpError, parse, parseObjectId } from '../http.js';
import { logActivity } from '../activity.js';
import { takeHourlySlot } from '../rateLimit.js';
import { shortName } from './reviews.js';
import { FLAGGED, toScreening } from '../screening.js';

// Questions on products (collection `questions`): logged-in customers ask, admins answer. Only answered questions are
// shown on the product page; until then only the asker sees theirs ("waiting for an answer") and may delete it. The
// asker is emailed when it is first answered. Admins can hide a question (spam), which also takes it off the page.
// { productId, userId, author ("Asha R."), text, createdAt, answer: { text, by, at, updatedAt } | null, hidden,
//   customerAnswers?: [{ _id, userId, author, text, at, hidden }] }
// Customer answers (stage 133): customers with a delivered order containing the product can answer other customers'
// questions, once each, shown under the store's answer as "Bought this". A question with a shown customer answer is on
// the product page even before the store answers it; admins can hide any customer answer.

const QUESTION_PAGE = 10;
const ADMIN_PAGE = 25;
export const QUESTIONS_PER_HOUR = 5;
const MAX_PENDING = 20; // unanswered questions one customer can have open across the store
export const MAX_CUSTOMER_ANSWERS = 10; // per question
export const CUSTOMER_ANSWERS_PER_HOUR = 10;
const OPEN_FOR_BUYERS = 10; // questions shown to a buyer under "Can you help?"
const customerAnswerBody = z.object({
  text: z.string().trim().min(2, 'Write your answer').max(500, 'At most 500 characters'),
});

const questionBody = z.object({
  text: z.string().trim().min(5, 'Write your question (at least 5 characters)').max(500, 'At most 500 characters'),
});
const answerBody = z.object({
  text: z.string().trim().min(1, 'Write the answer').max(2000, 'At most 2000 characters'),
});
const listQuery = z.object({ page: z.coerce.number().int().min(1).max(1000).default(1) });
const adminQuery = z.object({
  status: z.enum(['unanswered', 'answered', 'hidden', 'flagged']).default('unanswered'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
const visibilityBody = z.object({ hidden: z.boolean() });

const toCustomerAnswer = (a, admin = false) => ({
  id: a._id.toString(),
  author: a.author,
  text: a.text,
  at: a.at,
  ...(admin && { hidden: a.hidden }),
});
// `admin` also lists hidden customer answers, marked.
export const toQuestion = (doc, admin = false) => ({
  id: doc._id.toString(),
  text: doc.text,
  author: doc.author,
  createdAt: doc.createdAt,
  answer: doc.answer ? { text: doc.answer.text, at: doc.answer.at } : null,
  customerAnswers: (doc.customerAnswers ?? []).filter((a) => admin || !a.hidden).map((a) => toCustomerAnswer(a, admin)),
});
// On the product page: answered by the store, or by a customer whose answer isn't hidden.
const ANSWERED = {
  $or: [{ answer: { $ne: null } }, { customerAnswers: { $elemMatch: { hidden: false } } }],
};

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

  // Whether `userId` has had the product delivered, which lets them review it and answer questions about it.
  const boughtIt = (userId, productId) =>
    db
      .collection('orders')
      .findOne({ userId, status: 'delivered', 'items.productId': productId }, { projection: { _id: 1 } });

  // Answered questions (by the store or a customer), newest answer first; for a logged-in visitor also their own that
  // wait for an answer, and for a buyer (stage 133) questions they could answer.
  router.get('/products/:slug/questions', async (req, res) => {
    const { page } = parse(listQuery, req.query);
    const { _id: productId } = await findProduct(req.params.slug);
    const filter = { productId, hidden: false, ...ANSWERED };
    const buyer = req.user && (await boughtIt(req.user._id, productId));
    const [docs, total, mine, open] = await Promise.all([
      questions
        .aggregate([
          { $match: filter },
          // The store's answer's time, else the first shown customer answer's.
          {
            $addFields: {
              answeredAt: {
                $ifNull: [
                  '$answer.at',
                  {
                    $min: {
                      $map: {
                        input: { $filter: { input: '$customerAnswers', cond: { $eq: ['$$this.hidden', false] } } },
                        in: '$$this.at',
                      },
                    },
                  },
                ],
              },
            },
          },
          { $sort: { answeredAt: -1, _id: -1 } },
          { $skip: (page - 1) * QUESTION_PAGE },
          { $limit: QUESTION_PAGE },
        ])
        .toArray(),
      questions.countDocuments(filter),
      req.user
        ? questions
            .find({
              productId,
              userId: req.user._id,
              answer: null,
              hidden: false,
              customerAnswers: { $not: { $elemMatch: { hidden: false } } },
            })
            .sort({ createdAt: -1 })
            .toArray()
        : [],
      buyer
        ? questions
            .find({
              productId,
              hidden: false,
              answer: null,
              userId: { $ne: req.user._id },
              'customerAnswers.userId': { $ne: req.user._id },
            })
            .sort({ createdAt: -1 })
            .limit(OPEN_FOR_BUYERS)
            .toArray()
        : [],
    ]);
    // An asker's own question shows once: under "waiting" until anyone answers it, then in the list.
    const waiting = mine.map((q) => toQuestion(q));
    res.json({
      items: docs.map((q) => toQuestion(q)),
      total,
      page,
      pageSize: QUESTION_PAGE,
      waiting,
      canAnswer: Boolean(buyer),
      open: open.map((q) => toQuestion(q)),
    });
  });

  // A buyer answers another customer's question (stage 133), once per question.
  router.post('/questions/:id/answers', requireUser, async (req, res) => {
    const _id = parseObjectId(req.params.id, 'question id');
    const { text } = parse(customerAnswerBody, req.body);
    const userId = req.user._id;
    const question = await questions.findOne({ _id, hidden: false });
    if (!question) throw new HttpError(404, 'Question not found');
    const product = await products.findOne(
      { _id: question.productId, active: true },
      { projection: { title: 1, slug: 1 } },
    );
    if (!product) throw new HttpError(404, 'Question not found');
    if (question.userId?.equals(userId)) throw new HttpError(400, "You can't answer your own question");
    if (!(await boughtIt(userId, question.productId))) {
      throw new HttpError(403, 'You can answer once an order with this product has been delivered to you');
    }
    if (!(await takeHourlySlot(db, `customerAnswer:${userId}`, CUSTOMER_ANSWERS_PER_HOUR))) {
      throw new HttpError(
        429,
        `You can answer ${CUSTOMER_ANSWERS_PER_HOUR} questions an hour. Please try again later.`,
      );
    }
    const answer = {
      _id: new ObjectId(),
      userId,
      author: shortName(req.user.name),
      text,
      at: new Date(),
      hidden: false,
    };
    // Once per customer, and at most MAX_CUSTOMER_ANSWERS, both in the filter so two tabs can't get past them.
    const after = await questions.findOneAndUpdate(
      {
        _id,
        hidden: false,
        'customerAnswers.userId': { $ne: userId },
        [`customerAnswers.${MAX_CUSTOMER_ANSWERS - 1}`]: { $exists: false },
      },
      { $push: { customerAnswers: answer } },
      { returnDocument: 'after' },
    );
    if (!after) {
      const again = await questions.findOne({ _id, 'customerAnswers.userId': userId }, { projection: { _id: 1 } });
      throw new HttpError(409, again ? 'You have answered this question already' : 'This question has enough answers');
    }
    // The asker hears about the first answer of any kind (the store's sends its own email).
    const first = !after.answer && after.customerAnswers.length === 1;
    if (first) await sendQuestionAnswered(ctx, after, product, { label: 'A customer who bought it answered', text });
    res.status(201).json(toQuestion(after));
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
  router.use('/admin/questions', requirePermission('questions'));

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
      ...toQuestion(q, true),
      hidden: q.hidden,
      screening: toScreening(q),
      product: product.get(q.productId.toString()) ?? null,
      // No asker when their account was closed (accountData.js): the question stays, signed "A customer".
      customer: (q.userId && person.get(q.userId.toString())) ?? null,
    }));
  }

  // Unanswered (oldest first, so nobody waits longest), answered or hidden (newest first), with a count of each.
  router.get('/admin/questions', async (req, res) => {
    const { status, page } = parse(adminQuery, req.query);
    const filters = {
      unanswered: UNANSWERED,
      answered: { answer: { $ne: null }, hidden: false },
      hidden: { hidden: true },
      // Flagged by screening (screening.js) and not dealt with yet.
      flagged: FLAGGED,
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

  // Hides or shows one customer answer (stage 133).
  router.post('/admin/questions/:id/customer-answers/:answerId/visibility', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'question id');
    const answerId = parseObjectId(req.params.answerId, 'answer id');
    const { hidden } = parse(visibilityBody, req.body);
    const before = await questions.findOneAndUpdate(
      { _id, 'customerAnswers._id': answerId },
      { $set: { 'customerAnswers.$.hidden': hidden } },
      { returnDocument: 'before' },
    );
    if (!before) throw new HttpError(404, 'Answer not found');
    const old = before.customerAnswers.find((a) => a._id.equals(answerId));
    const doc = await questions.findOne({ _id });
    const [view] = await adminView([doc]);
    if (old.hidden !== hidden) {
      await logActivity(db, req.user, {
        area: 'questions',
        action: hidden ? "Hid a customer's answer" : "Showed a customer's answer",
        target: {
          label: `${view.product?.title ?? 'A product'}: “${doc.text}”`,
          path: '/admin/questions?status=answered',
        },
        changes: [{ field: 'Answer', to: old.text }],
      });
    }
    res.json(view);
  });

  return router;
}
