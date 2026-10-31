import express from 'express';
import { z } from 'zod';
import { parse } from '../http.js';
import { optionsOf } from '../variants.js';
import { toCategory, toProductCard } from './catalog.js';

// Compare products (stage 73): up to MAX_COMPARE products side by side, chosen in the browser (client/src/compare.js)
// and named in the page's address (/compare?slugs=a,b,c), so a comparison can be shared. Live prices and stock; hidden
// or unknown products drop out. The client keeps a comparison to one category; the server only says whether they are.

export const MAX_COMPARE = 3;

const compareQuery = z.object({
  slugs: z
    .string()
    .max(MAX_COMPARE * 161)
    .transform((s) => [...new Set(s.split(',').filter(Boolean))])
    .pipe(
      z
        .array(z.string().regex(/^[a-z0-9-]{1,160}$/, 'Invalid product address'))
        .max(MAX_COMPARE, `At most ${MAX_COMPARE} products`),
    ),
});

export function compareRouter({ db }) {
  const router = express.Router();

  router.get('/compare', async (req, res) => {
    const { slugs } = parse(compareQuery, req.query);
    const docs = slugs.length
      ? await db
          .collection('products')
          .find({ slug: { $in: slugs }, active: true })
          .toArray()
      : [];
    const bySlug = new Map(docs.map((d) => [d.slug, d]));
    const found = slugs.filter((s) => bySlug.has(s)).map((s) => bySlug.get(s));
    const categories = new Map(
      (
        await db
          .collection('categories')
          .find({ _id: { $in: found.map((d) => d.categoryId) } })
          .toArray()
      ).map((c) => [c._id.toString(), toCategory(c)]),
    );
    res.json({
      items: found.map((doc) => ({
        ...toProductCard(doc),
        category: categories.get(doc.categoryId.toString()) ?? null,
        highlights: doc.highlights ?? [],
        specs: doc.specs ?? [],
        // The kinds of option ("Size") and each combination with its own price and stock.
        options: doc.variants?.length ? optionsOf(doc) : [],
        variants: (doc.variants ?? []).map((v) => ({
          id: v._id.toString(),
          label: v.label,
          price: v.price,
          stock: v.stock,
        })),
      })),
      sameCategory: new Set(found.map((d) => d.categoryId.toString())).size <= 1,
    });
  });

  return router;
}
