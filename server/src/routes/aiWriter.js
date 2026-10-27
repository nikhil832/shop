import express from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { requirePermission, requireStaff } from '../staff.js';
import { MAX_HIGHLIGHTS } from '../ai.js';
import { HttpError, parse, parseObjectId } from '../http.js';
import { takeHourlySlot } from '../rateLimit.js';

// The admin's writing assistant: "Write for me" in the product form (stage 51), where Claude drafts a description and
// highlights, "Draft an answer" for a customer's question (stage 56) and photo descriptions for screen readers (stage
// 59). The admin edits every draft before saving; nothing is saved here. Each draft costs a little, so each admin gets
// AI_DRAFTS_PER_HOUR of all of them together.
export const AI_DRAFTS_PER_HOUR = 30;
// Image types Claude reads (uploads can also be these).
const READABLE = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const draftBody = z.object({
  title: z.string().trim().min(1, 'Enter a title first').max(150),
  brand: z.string().trim().min(1, 'Enter a brand first').max(60),
  categoryId: z.string('Choose a category first').regex(/^[0-9a-f]{24}$/, 'Choose a category first'),
  // The highlights already typed, as facts to keep to.
  facts: z.array(z.string().trim().min(1).max(100)).max(MAX_HIGHLIGHTS).default([]),
  // The product's first photo, if it's an upload (the seed's drawings aren't photos).
  image: z
    .string()
    .regex(/^\/api\/images\/[0-9a-f]{24}$/)
    .optional(),
});

const answerDraftBody = z.object({ questionId: z.string() });
const altTextBody = z.object({
  image: z.string().regex(/^\/api\/images\/[0-9a-f]{24}$/, 'Describe an uploaded photo'),
  title: z.string().trim().max(150).default(''),
});
// Earlier answers about the same product that go with the question, so the draft agrees with them.
const EARLIER_ANSWERS = 5;

export function aiWriterRouter({ db, ai }) {
  const router = express.Router();
  // Product copy and photo descriptions are admins' (the catalog); answer drafts go with answering questions.
  router.use('/admin/ai', requireStaff);

  // Whether the form shows the button.
  router.get('/admin/ai', (req, res) => {
    res.json({ enabled: Boolean(ai), model: ai?.model ?? null });
  });

  router.post('/admin/ai/product-draft', requireAdmin, async (req, res) => {
    const body = parse(draftBody, req.body);
    if (!ai)
      throw new HttpError(503, 'The writing assistant is off: the server has no ANTHROPIC_API_KEY.', { expose: true });
    const category = await db.collection('categories').findOne({ _id: parseObjectId(body.categoryId, 'category id') });
    if (!category) throw new HttpError(400, 'Choose a category first');
    const photo =
      body.image &&
      (await db
        .collection('images')
        .findOne({ _id: parseObjectId(body.image.split('/').pop(), 'image id'), contentType: { $in: READABLE } }));
    if (!(await takeHourlySlot(db, `aiDraft:${req.user._id}`, AI_DRAFTS_PER_HOUR))) {
      throw new HttpError(429, `You can ask for ${AI_DRAFTS_PER_HOUR} drafts an hour. Try again later.`);
    }
    const draft = await ai.writeProduct({
      title: body.title,
      brand: body.brand,
      category: category.name,
      facts: body.facts,
      image: photo ? { contentType: photo.contentType, data: Buffer.from(photo.data.buffer) } : null,
    });
    res.json(draft);
  });

  // A description of one uploaded photo for screen readers (stage 59), for the admin to check before saving the product.
  router.post('/admin/ai/alt-text', requireAdmin, async (req, res) => {
    const body = parse(altTextBody, req.body);
    if (!ai)
      throw new HttpError(503, 'The writing assistant is off: the server has no ANTHROPIC_API_KEY.', { expose: true });
    const photo = await db
      .collection('images')
      .findOne({ _id: parseObjectId(body.image.split('/').pop(), 'image id') });
    if (!photo) throw new HttpError(404, 'That photo is gone. Upload it again.');
    if (!READABLE.includes(photo.contentType)) throw new HttpError(400, "Claude can't read this kind of photo");
    if (!(await takeHourlySlot(db, `aiDraft:${req.user._id}`, AI_DRAFTS_PER_HOUR))) {
      throw new HttpError(429, `You can ask for ${AI_DRAFTS_PER_HOUR} drafts an hour. Try again later.`);
    }
    const alt = await ai.describePhoto({
      image: { contentType: photo.contentType, data: Buffer.from(photo.data.buffer) },
      title: body.title,
    });
    res.json({ alt });
  });

  router.post('/admin/ai/answer-draft', requirePermission('questions'), async (req, res) => {
    const body = parse(answerDraftBody, req.body);
    const _id = parseObjectId(body.questionId, 'question id');
    if (!ai)
      throw new HttpError(503, 'The writing assistant is off: the server has no ANTHROPIC_API_KEY.', { expose: true });
    const questions = db.collection('questions');
    const question = await questions.findOne({ _id });
    if (!question) throw new HttpError(404, 'Question not found');
    const product = await db.collection('products').findOne({ _id: question.productId });
    if (!product) throw new HttpError(409, "This question's product no longer exists");
    const [category, answered] = await Promise.all([
      db.collection('categories').findOne({ _id: product.categoryId }, { projection: { name: 1 } }),
      questions
        .find({ productId: product._id, _id: { $ne: _id }, hidden: false, answer: { $ne: null } })
        .sort({ 'answer.at': -1 })
        .limit(EARLIER_ANSWERS)
        .toArray(),
    ]);
    if (!(await takeHourlySlot(db, `aiDraft:${req.user._id}`, AI_DRAFTS_PER_HOUR))) {
      throw new HttpError(429, `You can ask for ${AI_DRAFTS_PER_HOUR} drafts an hour. Try again later.`);
    }
    const draft = await ai.answerQuestion({
      product: {
        title: product.title,
        brand: product.brand,
        category: category?.name ?? '',
        description: product.description ?? '',
        highlights: product.highlights ?? [],
        variants: (product.variants ?? []).map((v) => v.label),
      },
      answered: answered.map((q) => ({ text: q.text, answer: q.answer.text })),
      question: question.text,
    });
    res.json(draft);
  });

  return router;
}
