import express from 'express';
import { z } from 'zod';
import { HttpError, escapeRegex, parse } from '../http.js';

// Prices are integers in paise (₹1 = 100) everywhere: storage, API and client state.

export const PRODUCT_SORTS = {
  relevance: { 'rating.count': -1, _id: 1 }, // popularity until real search ranking exists
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
    if (query.q) {
      // Every word must appear in the title or brand.
      base.$and = query.q
        .split(/\s+/)
        .slice(0, 8)
        .map((word) => {
          const pattern = { $regex: escapeRegex(word), $options: 'i' };
          return { $or: [{ title: pattern }, { brand: pattern }] };
        });
    }
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
                { $sort: PRODUCT_SORTS[query.sort] },
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
    const category = await categories.findOne({ _id: doc.categoryId });
    res.json({
      ...toProductCard(doc),
      description: doc.description,
      highlights: doc.highlights ?? [],
      images: doc.images,
      category: category && toCategory(category),
    });
  });

  return router;
}
