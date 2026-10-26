import express from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { MAX_HIGHLIGHTS } from '../ai.js';
import { HttpError, parse, parseObjectId } from '../http.js';
import { takeHourlySlot } from '../rateLimit.js';

// "Write for me" in the admin product form (stage 51): Claude drafts a description and highlights, which the admin
// edits before saving. Nothing is saved here. Each draft costs a little, so each admin gets AI_DRAFTS_PER_HOUR.
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

export function aiWriterRouter({ db, ai }) {
  const router = express.Router();
  router.use('/admin/ai', requireAdmin);

  // Whether the form shows the button.
  router.get('/admin/ai', (req, res) => {
    res.json({ enabled: Boolean(ai), model: ai?.model ?? null });
  });

  router.post('/admin/ai/product-draft', async (req, res) => {
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

  return router;
}
