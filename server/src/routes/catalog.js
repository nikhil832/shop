import express from 'express';
import { optionsOf, toVariant } from '../variants.js';
import { z } from 'zod';
import { HttpError, escapeRegex, parse } from '../http.js';
import { imageAltsOf } from '../imageAlts.js';
import { recordSearch } from '../searchInsights.js';

// Prices are integers in paise (₹1 = 100) everywhere: storage, API and client state.

export const PRODUCT_SORTS = {
  // Popularity; with a search, products are ranked by searchScore first (see searchStages).
  relevance: { 'rating.count': -1, _id: 1 },
  price_asc: { price: 1, _id: 1 },
  price_desc: { price: -1, _id: 1 },
  newest: { createdAt: -1, _id: -1 },
  rating: { 'rating.avg': -1, 'rating.count': -1, _id: 1 },
};

const SUGGESTIONS = 6;
export const RELATED = 8;
// Frequently bought together: up to this many products, each bought in the same order as this one by at least
// BOUGHT_TOGETHER_CUSTOMERS different customers (one customer's basket alone would show what they bought), looked for
// in the product's latest BOUGHT_TOGETHER_ORDERS sales.
export const BOUGHT_TOGETHER = 6;
export const BOUGHT_TOGETHER_CUSTOMERS = 2;
const BOUGHT_TOGETHER_ORDERS = 1000;
// Orders that are sales, like SOLD in dashboard.js (importing it from there would make an import cycle through admin.js
// and orders.js, which import this file).
const SOLD = ['placed', 'shipped', 'delivered'];
// Recently viewed products are remembered in the browser (slugs, newest first); the page asks for their cards.
export const RECENTLY_VIEWED = 10;
const recentQuery = z.object({
  slugs: z
    .string()
    .max(RECENTLY_VIEWED * 161)
    .transform((s) => [...new Set(s.split(',').filter(Boolean))])
    .pipe(z.array(z.string().regex(/^[a-z0-9-]{1,160}$/, 'Invalid product address')).max(RECENTLY_VIEWED)),
});
const suggestQuery = z.object({ q: z.string().trim().min(1, 'Type something to search for').max(100) });

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
// ---- "Did you mean…?" ----

// The words the store knows (in shown products' titles, brands and highlights, and category names), each with how
// often it appears, rebuilt at most once a minute per database.
const WORDS_TTL_MS = 60_000;
const wordCache = new WeakMap();
async function storeWords(db) {
  const cached = wordCache.get(db);
  if (cached && Date.now() - cached.at < WORDS_TTL_MS) return cached.words;
  const [docs, cats] = await Promise.all([
    db
      .collection('products')
      .find({ active: true }, { projection: { title: 1, brand: 1, highlights: 1 } })
      .toArray(),
    db
      .collection('categories')
      .find({}, { projection: { name: 1 } })
      .toArray(),
  ]);
  const words = new Map();
  const texts = [...docs.flatMap((p) => [p.title, p.brand, ...(p.highlights ?? [])]), ...cats.map((c) => c.name)];
  for (const text of texts) {
    for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length >= 3 && !/^\d+$/.test(w)) words.set(w, (words.get(w) ?? 0) + 1);
    }
  }
  wordCache.set(db, { at: Date.now(), words });
  return words;
}

// Edits (insert, delete, change, or swapping two neighbours) to turn `a` into `b`.
export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// The search with each word that matches nothing the store knows replaced by the closest known word (one typo in a
// word of 3–5 letters, the first letter right in a 3-letter one; two from 6), or null when there's nothing to correct or a word has no close match. A word
// matches when a known word starts with it (as the search does), with plurals and synonyms counted.
export function correctSearch(q, words) {
  const known = [...words.keys()];
  const parts = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  let changed = false;
  const fixed = parts.map((word) => {
    const base = singular(word);
    if (SYNONYMS[base] || known.some((k) => k.startsWith(base))) return word;
    const allowed = word.length < 3 ? 0 : word.length <= 5 ? 1 : 2;
    let best = null;
    for (const k of known) {
      if (k.length < word.length - allowed) continue; // longer ones are compared by their start too
      // A typo in the whole word, or in the start of a longer one ("samsn" → "samsung").
      const whole = editDistance(word, k);
      const distance = Math.min(whole, editDistance(word, k.slice(0, word.length)));
      if (distance > allowed) continue;
      if (word.length === 3 && k[0] !== word[0]) continue; // three letters: only with the right first letter ("ari" → "air")
      // Fewest edits, then a whole word over the start of one ("ari" → "air", not "arcbook"), then the same first
      // letter, then the most common word.
      const rank = [distance, whole === distance ? 0 : 1, k[0] === word[0] ? 0 : 1, -words.get(k)];
      if (!best || compareRanks(rank, best.rank) < 0) best = { k, rank };
    }
    if (!best) return null;
    changed = true;
    return best.k;
  });
  return changed && fixed.every(Boolean) ? fixed.join(' ') : null;
}
const compareRanks = (a, b) => a.reduce((r, x, i) => r || x - b[i], 0);

export async function searchStages(categories, q) {
  const terms = searchTerms(q);
  const allCategories = await categories.find({}, { projection: { name: 1, slug: 1, sortOrder: 1 } }).toArray();
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
  // Categories whose name matches every term ("lapt" → Laptops), for the search suggestions.
  const matchingCategories = allCategories
    .filter((c) => terms.every((regex) => new RegExp(regex, 'i').test(c.name)))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  return { filter, score, matchingCategories };
}

export const toCategory = (doc) => ({ id: doc._id.toString(), slug: doc.slug, name: doc.name, image: doc.image });

export const toProductCard = (doc) => ({
  id: doc._id.toString(),
  slug: doc.slug,
  title: doc.title,
  brand: doc.brand,
  // For comparing (stage 73): products are compared within one category.
  categoryId: doc.categoryId.toString(),
  price: doc.price,
  mrp: doc.mrp,
  stock: doc.stock,
  image: doc.images[0] ?? null,
  rating: doc.rating,
  // Variants: the option's name ("Size"), or null; `priceFrom` when they don't all cost the same ("from ₹X").
  variantName: doc.variants?.length ? doc.variantName : null,
  priceFrom: Boolean(doc.variants?.some((v) => v.price !== doc.price)),
  // In a running sale (sales.js): its name and end, for the "Sale" tag and "Sale ends in…".
  sale: doc.sale ? { name: doc.sale.name, percent: doc.sale.percent, endsAt: doc.sale.endsAt } : null,
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

    const total = result.total[0]?.n ?? 0;
    // A plain search (the first page, no filters, the default order) is counted for Admin → Searches; changing the
    // page, order or filters of a search asks again and isn't a new search.
    const plain =
      query.page === 1 &&
      query.sort === 'relevance' &&
      !query.category &&
      !brandList?.length &&
      query.minPrice === undefined &&
      query.maxPrice === undefined &&
      !query.rating &&
      !query.inStock;
    if (query.q && plain) await recordSearch(db, query.q, total);
    // Nothing found: a corrected search ("samsng" → "samsung"), offered only if it finds something with the same filters.
    let suggestion = null;
    if (!total && query.q) {
      const corrected = correctSearch(query.q, await storeWords(db));
      if (corrected) {
        const fixed = { ...match, $and: (await searchStages(categories, corrected)).filter };
        const found = await products.countDocuments(fixed);
        if (found) suggestion = { q: corrected, total: found };
      }
    }

    res.json({
      items: result.items.map(toProductCard),
      total,
      suggestion,
      page: query.page,
      pageSize: query.pageSize,
      brands: brands.map((b) => ({ name: b._id, count: b.count })),
    });
  });

  // What the header's search box offers while typing: matching categories, the best few products (ranked like the
  // relevance sort) and how many products match in all.
  router.get('/search/suggest', async (req, res) => {
    const { q } = parse(suggestQuery, req.query);
    const search = await searchStages(categories, q);
    const match = { active: true, $and: search.filter };
    const [items, total] = await Promise.all([
      products
        .aggregate([
          { $match: match },
          { $addFields: { searchScore: search.score } },
          { $sort: { searchScore: -1, ...PRODUCT_SORTS.relevance } },
          { $limit: SUGGESTIONS },
          { $project: { slug: 1, title: 1, brand: 1, price: 1 } },
        ])
        .toArray(),
      products.countDocuments(match),
    ]);
    res.json({
      categories: search.matchingCategories.slice(0, 3).map((c) => ({ slug: c.slug, name: c.name })),
      products: items.map((p) => ({ slug: p.slug, title: p.title, brand: p.brand, price: p.price })),
      total,
    });
  });

  // Similar products for a product page: same category and brand first, then same category, then same brand; in
  // stock before sold out, then by popularity.
  router.get('/products/:slug/related', async (req, res) => {
    const doc = await products.findOne(
      { slug: req.params.slug, active: true },
      { projection: { categoryId: 1, brand: 1 } },
    );
    if (!doc) throw new HttpError(404, 'Product not found');
    const items = await products
      .aggregate([
        {
          $match: { active: true, _id: { $ne: doc._id }, $or: [{ categoryId: doc.categoryId }, { brand: doc.brand }] },
        },
        {
          $addFields: {
            relatedScore: {
              $add: [points({ $eq: ['$categoryId', doc.categoryId] }, 2), points({ $eq: ['$brand', doc.brand] }, 1)],
            },
            inStock: points({ $gt: ['$stock', 0] }, 1),
          },
        },
        { $sort: { relatedScore: -1, inStock: -1, 'rating.count': -1, _id: 1 } },
        { $limit: RELATED },
      ])
      .toArray();
    res.json({ items: items.map(toProductCard) });
  });

  // What customers bought in the same orders as this product: by how many customers, then how many orders, then
  // popularity. Only products on sale and in stock, as the row is for adding to the cart.
  router.get('/products/:slug/bought-together', async (req, res) => {
    const doc = await products.findOne({ slug: req.params.slug, active: true }, { projection: { _id: 1 } });
    if (!doc) throw new HttpError(404, 'Product not found');
    const items = await db
      .collection('orders')
      .aggregate([
        // Sales only: unpaid and cancelled orders don't count.
        { $match: { 'items.productId': doc._id, status: { $in: SOLD } } },
        { $sort: { createdAt: -1 } },
        { $limit: BOUGHT_TOGETHER_ORDERS },
        { $unwind: '$items' },
        { $match: { 'items.productId': { $ne: doc._id } } },
        // Two sizes of one product in an order are one order.
        { $group: { _id: '$items.productId', orders: { $addToSet: '$_id' }, customers: { $addToSet: '$userId' } } },
        { $project: { orders: { $size: '$orders' }, customers: { $size: '$customers' } } },
        { $match: { customers: { $gte: BOUGHT_TOGETHER_CUSTOMERS } } },
        {
          $lookup: {
            from: 'products',
            localField: '_id',
            foreignField: '_id',
            pipeline: [{ $match: { active: true, stock: { $gt: 0 } } }],
            as: 'product',
          },
        },
        { $unwind: '$product' },
        { $sort: { customers: -1, orders: -1, 'product.rating.count': -1, _id: 1 } },
        { $limit: BOUGHT_TOGETHER },
      ])
      .toArray();
    res.json({ items: items.map((i) => toProductCard(i.product)) });
  });

  // Cards for the products this browser viewed lately, in the order asked; hidden or unknown ones are left out.
  router.get('/recently-viewed', async (req, res) => {
    const { slugs } = parse(recentQuery, req.query);
    const docs = slugs.length ? await products.find({ slug: { $in: slugs }, active: true }).toArray() : [];
    const bySlug = new Map(docs.map((d) => [d.slug, d]));
    res.json({ items: slugs.filter((s) => bySlug.has(s)).map((s) => toProductCard(bySlug.get(s))) });
  });

  router.get('/products/:slug', async (req, res) => {
    const doc = await products.findOne({ slug: req.params.slug, active: true });
    if (!doc) throw new HttpError(404, 'Product not found');
    const mine = { userId: req.user?._id, productId: doc._id };
    const [category, saved, alerts] = await Promise.all([
      categories.findOne({ _id: doc.categoryId }),
      req.user && db.collection('wishlist').findOne(mine),
      req.user &&
        db
          .collection('stockAlerts')
          .find(mine, { projection: { variantId: 1 } })
          .toArray(),
    ]);
    res.json({
      ...toProductCard(doc),
      description: doc.description,
      highlights: doc.highlights ?? [],
      images: doc.images,
      // Descriptions of uploaded photos for screen readers, by address (the title stands in for the rest).
      imageAlts: imageAltsOf(doc),
      // The option names ("Colour", "Size"), one row of choices each; [] without variants.
      options: doc.variants?.length ? optionsOf(doc) : [],
      variants: (doc.variants ?? []).map(toVariant),
      category: category && toCategory(category),
      wishlisted: Boolean(saved), // always false when logged out
      // Asked to be emailed when it's back: the whole product (out of stock), or these sold-out variants.
      stockAlert: Boolean(alerts && alerts.some((a) => !a.variantId)),
      stockAlertVariants: alerts ? alerts.filter((a) => a.variantId).map((a) => a.variantId.toString()) : [],
    });
  });

  return router;
}
