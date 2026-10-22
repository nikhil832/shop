import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { HttpError, escapeRegex, parse, parseObjectId } from '../http.js';
import { ICONS, image, slugify } from '../seed.js';
import { refundPayment } from '../payments.js';
import { cancelOrder, ORDER_STATUSES, toOrder } from './orders.js';
import { sendOrderEmail } from '../emails.js';
import { changeRating, inTransaction, toReview } from './reviews.js';

const hexId = (what) => z.string().regex(/^[0-9a-f]{24}$/, `Choose a ${what}`);

// Uploaded photos (/api/images/<id>) or generated SVG placeholders like the seed data.
const imageRef = z
  .string()
  .max(20000)
  .refine((s) => /^\/api\/images\/[0-9a-f]{24}$/.test(s) || s.startsWith('data:image/svg+xml,'), 'Invalid image');

// Prices in paise; the admin form converts from rupees.
const productFields = z.object({
  title: z.string().trim().min(1, 'Enter a title').max(150),
  brand: z.string().trim().min(1, 'Enter a brand').max(60),
  categoryId: hexId('category'),
  description: z.string().trim().max(5000),
  highlights: z.array(z.string().trim().min(1).max(100)).max(8),
  price: z.number().int().min(100, 'Price must be at least ₹1').max(100_000_000),
  mrp: z.number().int().min(100, 'MRP must be at least ₹1').max(100_000_000),
  stock: z.number().int().min(0).max(100_000),
  images: z.array(imageRef).max(5),
  active: z.boolean(),
});
const createProduct = productFields.extend({
  description: productFields.shape.description.default(''),
  highlights: productFields.shape.highlights.default([]),
  images: productFields.shape.images.default([]),
  active: productFields.shape.active.default(true),
});
const updateProduct = productFields.partial();

const productQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: hexId('category').optional(),
  status: z.enum(['active', 'hidden', 'low']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

const categoryBody = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(40),
  icon: z.string().trim().min(1).max(8).optional(),
});

const orderQuery = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

const reviewQuery = z.object({
  status: z.enum(['visible', 'hidden']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
const reviewVisibility = z.object({ hidden: z.boolean() });

const statusBody = z.object({ status: z.enum(['shipped', 'delivered', 'cancelled']) });
// Which status each step moves on from. Cancelling also puts the stock back (see cancelOrder).
const NEXT_FROM = { shipped: ['placed'], delivered: ['shipped'], cancelled: ['awaiting_payment', 'placed', 'shipped'] };

const PRODUCT_PAGE = 50;
const ORDER_PAGE = 25;
const LOW_STOCK = 5;
const DEFAULT_ICON = '🛍️';

const toAdminProduct = (doc) => ({
  id: doc._id.toString(),
  slug: doc.slug,
  title: doc.title,
  brand: doc.brand,
  categoryId: doc.categoryId.toString(),
  description: doc.description,
  highlights: doc.highlights ?? [],
  price: doc.price,
  mrp: doc.mrp,
  stock: doc.stock,
  images: doc.images,
  active: doc.active,
  updatedAt: doc.updatedAt,
});

const categoryIcon = (category) => category.icon ?? ICONS[category.slug] ?? DEFAULT_ICON;

export function adminRouter(ctx) {
  const { db } = ctx;
  const products = db.collection('products');
  const categories = db.collection('categories');
  const orders = db.collection('orders');
  const users = db.collection('users');
  const router = express.Router();

  // Every route below needs an admin. 401 when logged out, 403 for customers.
  router.use('/admin', requireAdmin);

  async function findCategory(id) {
    const category = await categories.findOne({ _id: new ObjectId(id) });
    if (!category) throw new HttpError(400, 'categoryId: Choose a category');
    return category;
  }

  // ---- Products ----

  router.get('/admin/products', async (req, res) => {
    const query = parse(productQuery, req.query);
    const filter = {};
    if (query.q) {
      const pattern = { $regex: escapeRegex(query.q), $options: 'i' };
      filter.$or = [{ title: pattern }, { brand: pattern }, { slug: pattern }];
    }
    if (query.category) filter.categoryId = new ObjectId(query.category);
    if (query.status === 'active') filter.active = true;
    if (query.status === 'hidden') filter.active = false;
    if (query.status === 'low') filter.stock = { $lte: LOW_STOCK };
    const [items, total] = await Promise.all([
      products
        .find(filter)
        .sort({ title: 1, _id: 1 })
        .skip((query.page - 1) * PRODUCT_PAGE)
        .limit(PRODUCT_PAGE)
        .toArray(),
      products.countDocuments(filter),
    ]);
    res.json({ items: items.map(toAdminProduct), total, page: query.page, pageSize: PRODUCT_PAGE });
  });

  router.get('/admin/products/:id', async (req, res) => {
    const doc = await products.findOne({ _id: parseObjectId(req.params.id, 'product id') });
    if (!doc) throw new HttpError(404, 'Product not found');
    res.json(toAdminProduct(doc));
  });

  router.post('/admin/products', async (req, res) => {
    const body = parse(createProduct, req.body);
    if (body.mrp < body.price) throw new HttpError(400, 'mrp: MRP must be at least the price');
    const category = await findCategory(body.categoryId);
    const now = new Date();
    const base = slugify(body.title) || 'product';
    // The slug comes from the title and never changes afterwards, so product links keep working.
    for (let n = 1; n <= 50; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      const doc = {
        ...body,
        slug,
        categoryId: category._id,
        images: body.images.length ? body.images : [image(slug, categoryIcon(category), body.brand)],
        rating: { avg: 0, count: 0 },
        createdAt: now,
        updatedAt: now,
      };
      try {
        const { insertedId } = await products.insertOne(doc);
        return res.status(201).json(toAdminProduct({ ...doc, _id: insertedId }));
      } catch (err) {
        if (err.code !== 11000) throw err;
      }
    }
    throw new HttpError(409, 'Too many products with this title');
  });

  router.patch('/admin/products/:id', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'product id');
    const body = parse(updateProduct, req.body);
    const current = await products.findOne({ _id });
    if (!current) throw new HttpError(404, 'Product not found');
    if ((body.mrp ?? current.mrp) < (body.price ?? current.price)) {
      throw new HttpError(400, 'mrp: MRP must be at least the price');
    }
    const update = { ...body, updatedAt: new Date() };
    if (body.categoryId) update.categoryId = (await findCategory(body.categoryId))._id;
    if (body.images?.length === 0) {
      const category = await categories.findOne({ _id: update.categoryId ?? current.categoryId });
      update.images = [
        image(current.slug, category ? categoryIcon(category) : DEFAULT_ICON, body.brand ?? current.brand),
      ];
    }
    const doc = await products.findOneAndUpdate({ _id }, { $set: update }, { returnDocument: 'after' });
    res.json(toAdminProduct(doc));
  });

  // ---- Categories ----

  router.get('/admin/categories', async (req, res) => {
    const [docs, counts] = await Promise.all([
      categories.find().sort({ sortOrder: 1, name: 1 }).toArray(),
      products.aggregate([{ $group: { _id: '$categoryId', n: { $sum: 1 } } }]).toArray(),
    ]);
    const countOf = new Map(counts.map((c) => [c._id.toString(), c.n]));
    res.json(
      docs.map((c) => ({
        id: c._id.toString(),
        slug: c.slug,
        name: c.name,
        icon: categoryIcon(c),
        image: c.image,
        productCount: countOf.get(c._id.toString()) ?? 0,
      })),
    );
  });

  router.post('/admin/categories', async (req, res) => {
    const body = parse(categoryBody, req.body);
    const slug = slugify(body.name);
    if (!slug) throw new HttpError(400, 'name: Use letters or numbers in the name');
    const [last] = await categories.find().sort({ sortOrder: -1 }).limit(1).toArray();
    const icon = body.icon ?? DEFAULT_ICON;
    const doc = {
      slug,
      name: body.name,
      icon,
      image: image(slug, icon),
      sortOrder: (last?.sortOrder ?? -1) + 1,
      createdAt: new Date(),
    };
    try {
      const { insertedId } = await categories.insertOne(doc);
      doc._id = insertedId;
    } catch (err) {
      if (err.code === 11000) throw new HttpError(409, 'A category with this name already exists');
      throw err;
    }
    res.status(201).json({ id: doc._id.toString(), slug, name: doc.name, icon, image: doc.image, productCount: 0 });
  });

  router.patch('/admin/categories/:id', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'category id');
    const body = parse(categoryBody.partial(), req.body);
    const current = await categories.findOne({ _id });
    if (!current) throw new HttpError(404, 'Category not found');
    // The slug (used in links) stays as it was; only the shown name and icon change.
    const update = { ...body };
    if (body.icon) update.image = image(current.slug, body.icon);
    const doc = await categories.findOneAndUpdate({ _id }, { $set: update }, { returnDocument: 'after' });
    res.json({ id: doc._id.toString(), slug: doc.slug, name: doc.name, icon: categoryIcon(doc), image: doc.image });
  });

  // Body: every category id, in the new display order.
  router.put('/admin/categories/order', async (req, res) => {
    const { ids } = parse(z.object({ ids: z.array(hexId('category')).max(200) }), req.body);
    const existing = await categories.find({}, { projection: { _id: 1 } }).toArray();
    const known = new Set(existing.map((c) => c._id.toString()));
    if (ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) {
      throw new HttpError(400, 'ids: List every category exactly once');
    }
    await categories.bulkWrite(
      ids.map((id, i) => ({ updateOne: { filter: { _id: new ObjectId(id) }, update: { $set: { sortOrder: i } } } })),
    );
    res.status(204).end();
  });

  router.delete('/admin/categories/:id', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'category id');
    // Hidden products count too: they still belong to the category.
    const count = await products.countDocuments({ categoryId: _id });
    if (count) {
      throw new HttpError(409, `Move or hide its ${count} ${count === 1 ? 'product' : 'products'} first`);
    }
    const { deletedCount } = await categories.deleteOne({ _id });
    if (!deletedCount) throw new HttpError(404, 'Category not found');
    res.status(204).end();
  });

  // ---- Orders ----

  async function withCustomers(docs) {
    const people = await users
      .find({ _id: { $in: [...new Set(docs.map((o) => o.userId))] } }, { projection: { name: 1, email: 1 } })
      .toArray();
    const byId = new Map(people.map((u) => [u._id.toString(), { id: u._id.toString(), name: u.name, email: u.email }]));
    return docs.map((o) => ({ ...toOrder(o, { admin: true }), customer: byId.get(o.userId.toString()) ?? null }));
  }

  router.get('/admin/orders', async (req, res) => {
    const query = parse(orderQuery, req.query);
    const filter = {};
    if (query.status) filter.status = query.status;
    if (query.q) {
      // Matches the order number or the customer's name or email.
      const or = [];
      const hex = query.q.replace(/^#/, '').toLowerCase();
      if (/^\d{1,9}$/.test(hex)) or.push({ number: Number(hex) });
      // Older orders without a number show the end of their id instead.
      if (/^[0-9a-f]{4,24}$/.test(hex)) {
        or.push({ $expr: { $regexMatch: { input: { $toString: '$_id' }, regex: `${hex}$` } } });
      }
      const pattern = { $regex: escapeRegex(query.q), $options: 'i' };
      const people = await users
        .find({ $or: [{ email: pattern }, { name: pattern }] }, { projection: { _id: 1 } })
        .limit(500)
        .toArray();
      if (people.length) or.push({ userId: { $in: people.map((u) => u._id) } });
      filter.$or = or.length ? or : [{ _id: null }];
    }
    const [docs, total, counts] = await Promise.all([
      orders
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * ORDER_PAGE)
        .limit(ORDER_PAGE)
        .toArray(),
      orders.countDocuments(filter),
      orders.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    ]);
    res.json({
      items: await withCustomers(docs),
      total,
      page: query.page,
      pageSize: ORDER_PAGE,
      counts: Object.fromEntries(ORDER_STATUSES.map((s) => [s, counts.find((c) => c._id === s)?.n ?? 0])),
    });
  });

  router.get('/admin/orders/:id', async (req, res) => {
    const doc = await orders.findOne({ _id: parseObjectId(req.params.id, 'order id') });
    if (!doc) throw new HttpError(404, 'Order not found');
    res.json((await withCustomers([doc]))[0]);
  });

  router.post('/admin/orders/:id/status', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'order id');
    const { status } = parse(statusBody, req.body);
    let doc;
    if (status === 'cancelled') {
      doc = await cancelOrder(ctx, { _id }, { from: NEXT_FROM.cancelled, by: 'admin' });
    } else {
      const now = new Date();
      // The expected current status is part of the filter, so two admins clicking at once can't skip a step.
      doc = await orders.findOneAndUpdate(
        { _id, status: { $in: NEXT_FROM[status] } },
        { $set: { status, [`${status}At`]: now, updatedAt: now } },
        { returnDocument: 'after' },
      );
      if (!doc) {
        const existing = await orders.findOne({ _id });
        if (!existing) throw new HttpError(404, 'Order not found');
        throw new HttpError(409, `A ${existing.status} order can't be marked ${status}`);
      }
      await sendOrderEmail(ctx, doc, status);
    }
    res.json((await withCustomers([doc]))[0]);
  });

  // For a cancelled online order whose automatic refund failed (e.g. Razorpay was unreachable).
  router.post('/admin/orders/:id/refund', async (req, res) => {
    const doc = await orders.findOne({ _id: parseObjectId(req.params.id, 'order id') });
    if (!doc) throw new HttpError(404, 'Order not found');
    if (doc.status !== 'cancelled' || doc.payment?.status !== 'refund_failed') {
      throw new HttpError(409, 'Only a cancelled order whose refund failed can be retried');
    }
    res.json((await withCustomers([await refundPayment(ctx, doc)]))[0]);
  });

  // ---- Reviews ----

  const reviews = db.collection('reviews');
  const REVIEW_PAGE = 20;

  // Adds the product (title, slug) and the reviewer's full name and email, which customers never see.
  async function reviewDetails(docs) {
    const [items, people] = await Promise.all([
      products
        .find({ _id: { $in: docs.map((r) => r.productId) } }, { projection: { title: 1, slug: 1, active: 1 } })
        .toArray(),
      users.find({ _id: { $in: docs.map((r) => r.userId) } }, { projection: { name: 1, email: 1 } }).toArray(),
    ]);
    const product = new Map(items.map((p) => [p._id.toString(), { title: p.title, slug: p.slug, active: p.active }]));
    const person = new Map(people.map((u) => [u._id.toString(), { name: u.name, email: u.email }]));
    return docs.map((r) => ({
      ...toReview(r),
      product: product.get(r.productId.toString()) ?? null,
      customer: person.get(r.userId.toString()) ?? null,
    }));
  }

  router.get('/admin/reviews', async (req, res) => {
    const query = parse(reviewQuery, req.query);
    const filter = query.status ? { hidden: query.status === 'hidden' } : {};
    const [docs, total, counts] = await Promise.all([
      reviews
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * REVIEW_PAGE)
        .limit(REVIEW_PAGE)
        .toArray(),
      reviews.countDocuments(filter),
      reviews.aggregate([{ $group: { _id: '$hidden', n: { $sum: 1 } } }]).toArray(),
    ]);
    res.json({
      items: await reviewDetails(docs),
      total,
      page: query.page,
      pageSize: REVIEW_PAGE,
      counts: {
        visible: counts.find((c) => c._id === false)?.n ?? 0,
        hidden: counts.find((c) => c._id === true)?.n ?? 0,
      },
    });
  });

  // Hiding takes a review off the product page and out of its rating; showing puts it back. Nothing is deleted.
  router.post('/admin/reviews/:id/visibility', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'review id');
    const { hidden } = parse(reviewVisibility, req.body);
    const doc = await inTransaction(ctx.client, async (session) => {
      const now = new Date();
      // Only a change of state moves the rating, so clicking twice can't count a review twice.
      const changed = await reviews.findOneAndUpdate(
        { _id, hidden: !hidden },
        { $set: { hidden, hiddenAt: hidden ? now : null } },
        { session, returnDocument: 'after' },
      );
      if (changed) {
        const sign = hidden ? -1 : 1;
        await changeRating(db, changed.productId, { sum: sign * changed.rating, count: sign }, session);
        return changed;
      }
      return reviews.findOne({ _id }, { session });
    });
    if (!doc) throw new HttpError(404, 'Review not found');
    res.json((await reviewDetails([doc]))[0]);
  });

  return router;
}
