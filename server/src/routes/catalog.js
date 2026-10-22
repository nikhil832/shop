import express from 'express';
import { z } from 'zod';
import { HttpError, escapeRegex, parse } from '../http.js';

// Prices are integers in paise (₹1 = 100) everywhere: storage, API and client state.

export const PRODUCT_SORTS = {
  // Popularity; with a search, products are ranked by searchScore first (see searchStages).
  relevance: { 'rating.count': -1, _id: 1 },
  price_asc: { price: 1, _id: 1 },
  price_desc: { price: -1, _id: 1 },
  newest: { createdAt: -1, _id: -1 },
  rating: { 'rating.avg': -1, 'rating.count': -1, _id: 1 },
};

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(60).optional(),
  brand: z.string().max(500).optional(), // comma-separated
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  rating: z.coerce.number().min(1).max(5).optional(),
  inStock: z.enum(['1', 'true']).optional(),
  sort: z.enum(Object.keys(PRODUCT_SORTS)).default('relevance'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(48).default(24),
});

// Words that should find a category whose name doesn't contain them (after plurals are dropped).
const SYNONYMS = {
  phone: ['mobile'],
  smartphone: ['mobile'],
  cellphone: ['mobile'],
  notebook: ['laptop'],
  computer: ['laptop'],
  clothe: ['fashion'],
  clothing: ['fashion'],
  novel: ['book'],
};

// "laptops" → "laptop", "watches" → "watch", "glasses" → "glass"; short words and "bass" stay as they are.
function singular(word) {
  if (word.length > 4 && /(ch|sh|x|ss)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

// A search becomes up to 8 terms; each term is a list of alternatives (the word, singular, plus synonyms),
// matched case-insensitively at the start of a word, so "book" finds "Books" but not "Chromebook".
export function searchTerms(q) {
  const words = [...new Set(q.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
  return words.map((word) => {
    const base = singular(word);
    const alternatives = [...new Set([base, ...(SYNONYMS[base] ?? [])])];
    return `(?:^|[^a-z0-9])(?:${alternatives.map(escapeRegex).join('|')})`;
  });
}

const matches = (input, regex) => ({ $regexMatch: { input, regex, options: 'i' } });
const points = (condition, n) => ({ $cond: [condition, n, 0] });

// Each term must match the title, brand, a highlight or the category name. With the relevance sort, a score ranks
// the results: per term, title or brand 4, category 3, a highlight 1; the whole search in the title adds 5.
// Popularity breaks ties.
async function searchStages(categories, q) {
  const terms = searchTerms(q);
  const allCategories = await categories.find({}, { projection: { name: 1 } }).toArray();
  const categoryIds = (regex) => allCategories.filter((c) => new RegExp(regex, 'i').test(c.name)).map((c) => c._id);
  const filter = terms.map((regex) => {
    const pattern = { $regex: regex, $options: 'i' };
    return {
      $or: [
        { title: pattern },
        { brand: pattern },
        { highlights: pattern },
        { categoryId: { $in: categoryIds(regex) } },
      ],
    };
  });
  const termScores = terms.map((regex) => ({
    $add: [
      points(matches('$title', regex), 4),
      points(matches('$brand', regex), 4),
      points({ $in: ['$categoryId', categoryIds(regex)] }, 3),
      points(
        { $anyElementTrue: [{ $map: { input: { $ifNull: ['$highlights', []] }, in: matches('$$this', regex) } }] },
        1,
      ),
    ],
  }));
  const phrase = q.trim().toLowerCase().split(/\s+/).map(escapeRegex).join('\\s+');
  const score = { $add: [...termScores, points(matches('$title', phrase), 5)] };
  return { filter, score };
}

export const toCategory = (doc) => ({ id: doc._id.toString(), slug: doc.slug, name: doc.name, image: doc.image });

export const toProductCard = (doc) => ({
  id: doc._id.toString(),
  slug: doc.slug,
  title: doc.title,
  brand: doc.brand,
  price: doc.price,
  mrp: doc.mrp,
  stock: doc.stock,
  image: doc.images[0] ?? null,
  rating: doc.rating,
});

export function catalogRouter({ db }) {
  const categories = db.collection('categories');
  const products = db.collection('products');
  const router = express.Router();

  router.get('/categories', async (req, res) => {
    const docs = await categories.find().sort({ sortOrder: 1, name: 1 }).toArray();
    res.json(docs.map(toCategory));
  });

  router.get('/products', async (req, res) => {
    const query = parse(listQuery, req.query);
    const base = { active: true };

    if (query.category) {
      const category = await categories.findOne({ slug: query.category });
      if (!category) return res.json({ items: [], total: 0, page: query.page, pageSize: query.pageSize, brands: [] });
      base.categoryId = category._id;
    }
    const search = query.q ? await searchStages(categories, query.q) : null;
    if (search) base.$and = search.filter;
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      base.price = {};
      if (query.minPrice !== undefined) base.price.$gte = query.minPrice;
      if (query.maxPrice !== undefined) base.price.$lte = query.maxPrice;
    }
    if (query.rating) base['rating.avg'] = { $gte: query.rating };
    if (query.inStock) base.stock = { $gt: 0 };

    // The brand facet ignores the brand filter itself, so other brands stay selectable.
    const brandList = query.brand
      ?.split(',')
      .map((b) => b.trim())
      .filter(Boolean);
    const match = brandList?.length ? { ...base, brand: { $in: brandList } } : base;

    const [[result], brands] = await Promise.all([
      products
        .aggregate([
          { $match: match },
          {
            $facet: {
              items: [
                ...(search && query.sort === 'relevance'
                  ? [
                      { $addFields: { searchScore: search.score } },
                      { $sort: { searchScore: -1, ...PRODUCT_SORTS.relevance } },
                    ]
                  : [{ $sort: PRODUCT_SORTS[query.sort] }]),
                { $skip: (query.page - 1) * query.pageSize },
                { $limit: query.pageSize },
              ],
              total: [{ $count: 'n' }],
            },
          },
        ])
        .toArray(),
      products
        .aggregate([{ $match: base }, { $group: { _id: '$brand', count: { $sum: 1 } } }, { $sort: { _id: 1 } }])
        .toArray(),
    ]);

    res.json({
      items: result.items.map(toProductCard),
      total: result.total[0]?.n ?? 0,
      page: query.page,
      pageSize: query.pageSize,
      brands: brands.map((b) => ({ name: b._id, count: b.count })),
    });
  });

  router.get('/products/:slug', async (req, res) => {
    const doc = await products.findOne({ slug: req.params.slug, active: true });
    if (!doc) throw new HttpError(404, 'Product not found');
    const [category, saved] = await Promise.all([
      categories.findOne({ _id: doc.categoryId }),
      req.user && db.collection('wishlist').findOne({ userId: req.user._id, productId: doc._id }),
    ]);
    res.json({
      ...toProductCard(doc),
      description: doc.description,
      highlights: doc.highlights ?? [],
      images: doc.images,
      category: category && toCategory(category),
      wishlisted: Boolean(saved), // always false when logged out
    });
  });

  return router;
}
