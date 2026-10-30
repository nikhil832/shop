import { quantityDiscountField } from '../quantityDiscounts.js';
import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { clientIp, networkOf } from '../auth.js';
import { can, staffGuard } from '../staff.js';
import { assertPriceUnchanged } from '../sales.js';
import { HttpError, escapeRegex, parse, parseObjectId } from '../http.js';
import { ICONS, image, slugify } from '../seed.js';
import { refundPayment } from '../payments.js';
import { missingImages } from './images.js';
import { imageAltsOf, storedAlts } from '../imageAlts.js';
import { FLAGGED, toScreening } from '../screening.js';
import { MAX_OPTIONS, optionsOf, optionsPhrase, toVariant, variantLabel, variantTotals } from '../variants.js';
import { cancelOrder, ORDER_STATUSES, toOrder } from './orders.js';
import { sendOrderEmail } from '../emails.js';
import { changeRating, inTransaction, toReview } from './reviews.js';
import { byOf, recordStock, savedEntries } from '../stockHistory.js';
import { logActivity, orderTarget, productChanges, productTarget, rupees, yesNo } from '../activity.js';
import { RTO_REASONS } from '../cod.js';
import { notePrices } from '../priceHistory.js';
import { toAdminNote } from '../customerTags.js';

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
  // What it costs the store (stage 80, admins only), for profit; null clears it.
  cost: z.number().int().min(0).max(100_000_000).nullable(),
  // Its size guide (stage 88): a guide's id, 'none', or null for its category's.
  sizeGuide: z.union([z.literal('none'), z.string().regex(/^[0-9a-f]{24}$/, 'Choose a size guide')]).nullable(),
  // "Coming soon" (stage 92) while it has no stock, with the day it's expected (India time) if known; null for none.
  comingSoon: z
    .object({
      expected: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the expected day')
        .refine((d) => !Number.isNaN(Date.parse(d)), 'Choose the expected day')
        .nullable()
        .default(null),
    })
    .nullable(),
  // "Buy N or more, P% off each" (stage 99, quantityDiscounts.js); null for none.
  quantityDiscount: quantityDiscountField,
  images: z.array(imageRef).max(5),
  // Descriptions of uploaded photos for screen readers, by photo address (stage 59); empty ones are dropped.
  imageAlts: z
    .record(
      z.string().regex(/^\/api\/images\/[0-9a-f]{24}$/),
      z.string().trim().max(150, 'A photo description can be at most 150 characters'),
    )
    .refine((alts) => Object.keys(alts).length <= 5, 'At most 5 photo descriptions'),
  active: z.boolean(),
});
// Variants (one kind of option, e.g. Size): each with its own price, MRP and stock. `id` keeps an existing variant
// when editing (so stock and orders stay attached); new ones get one.
const optionValue = z.string().trim().min(1, 'Enter a value for each option of each variant').max(30);
const variantFields = z.object({
  id: z
    .string()
    .regex(/^[0-9a-f]{24}$/)
    .optional(),
  // One option: a label ("UK 8"), or `values: ["UK 8"]`. Two: `values: ["Black", "32"]`, in the order of `options`.
  label: optionValue.optional(),
  values: z.array(optionValue).min(1).max(MAX_OPTIONS).optional(),
  price: productFields.shape.price,
  mrp: productFields.shape.mrp,
  stock: productFields.shape.stock,
  // Left out: keeps the variant's cost (forms and files from before stage 80 don't send it).
  cost: productFields.shape.cost.optional(),
  // Some of the product's photos, shown when this variant is chosen; none means all of them.
  images: z.array(imageRef).max(5).default([]),
});
const variantList = z
  .array(variantFields)
  .max(40, 'At most 40 variants')
  .refine((vs) => vs.every((v) => v.mrp >= v.price), "A variant's MRP must be at least its price");
const variantName = z.string().trim().max(20);
const optionNames = z.array(z.string().trim().min(1, 'Name each option').max(20)).min(1).max(MAX_OPTIONS);

const createProduct = productFields
  .extend({
    description: productFields.shape.description.default(''),
    highlights: productFields.shape.highlights.default([]),
    images: productFields.shape.images.default([]),
    imageAlts: productFields.shape.imageAlts.default({}),
    active: productFields.shape.active.default(true),
    cost: productFields.shape.cost.default(null),
    sizeGuide: productFields.shape.sizeGuide.default(null),
    comingSoon: productFields.shape.comingSoon.default(null),
    quantityDiscount: productFields.shape.quantityDiscount.default(null),
    // With variants, the product's own price, MRP and stock come from them.
    price: productFields.shape.price.optional(),
    mrp: productFields.shape.mrp.optional(),
    stock: productFields.shape.stock.optional(),
    variantName: variantName.default(''),
    options: optionNames.optional(),
    variants: variantList.default([]),
  })
  .superRefine(checkVariantInput);
const updateProduct = productFields
  .partial()
  .extend({ variantName: variantName.optional(), options: optionNames.optional(), variants: variantList.optional() })
  .superRefine(checkVariantInput);

// The option names a request gives: `options`, or the one `variantName` (as before stage 24).
const namesOf = (body) => (body.options?.length ? body.options : body.variantName ? [body.variantName] : []);

// A product has variants (and then names for their one or two options) or its own price, MRP and stock. Each variant
// has a value for every option, and no two variants share them. `variants: []` means none: on create (the default) or
// when switching them off, the product's own numbers are needed.
function checkVariantInput(body, ctx) {
  if (body.variants?.length) {
    const names = namesOf(body);
    if (!names.length) {
      ctx.addIssue({ code: 'custom', path: ['variantName'], message: 'Name the option, e.g. Size or Colour' });
      return;
    }
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Give the two options different names' });
    }
    const values = body.variants.map((v) => v.values ?? (v.label === undefined ? [] : [v.label]));
    if (values.some((vs) => vs.length !== names.length)) {
      ctx.addIssue({
        code: 'custom',
        path: ['variants'],
        message: names.length > 1 ? 'Give each variant a value for every option' : 'Enter a label for each variant',
      });
    } else if (new Set(values.map((vs) => vs.join('\u0000').toLowerCase())).size !== values.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['variants'],
        message: names.length > 1 ? 'Each combination can be listed once' : 'Each variant needs a different label',
      });
    }
  }
  if (body.variants?.length === 0) {
    for (const field of ['price', 'mrp', 'stock']) {
      if (body[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: `Enter the ${field}` });
    }
  }
}

// What a product with variants stores for its options: the names, and the phrase for them ("Colour and size").
const storedOptions = (body) => ({ options: namesOf(body), variantName: optionsPhrase(namesOf(body)) });

// Variant photos must be among the product's own (`images`, as it will be saved).
function checkVariantImages(variants, images) {
  const own = new Set(images);
  if (variants.some((v) => v.images.some((url) => !own.has(url)))) {
    throw new HttpError(400, "variants: A variant's photos must be among the product's photos");
  }
}

// The variants to store (existing ids kept, new ones made) and the product totals they give.
function storedVariants(variants, current = []) {
  const known = new Map(current.map((v) => [v._id.toString(), v]));
  const list = variants.map((v) => ({
    _id: v.id && known.has(v.id) ? new ObjectId(v.id) : new ObjectId(),
    values: v.values ?? [v.label],
    label: variantLabel(v.values ?? [v.label]),
    price: v.price,
    mrp: v.mrp,
    stock: v.stock,
    // Not sent: the existing variant's cost stays.
    cost: v.cost !== undefined ? v.cost : (known.get(v.id)?.cost ?? null),
    images: v.images,
  }));
  return { variants: list, ...variantTotals(list) };
}

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

// At most this many orders are printed or shipped at once (a page of the list is 25).
const BULK_ORDERS = 50;
const orderIds = z
  .array(z.string().regex(/^[0-9a-f]{24}$/, 'Invalid order id'))
  .min(1, 'Choose some orders')
  .max(BULK_ORDERS, `At most ${BULK_ORDERS} orders at once`)
  .transform((ids) => [...new Set(ids)]);
const orderQuery = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  // Particular orders (comma-separated ids), in that order: the packing slips page.
  ids: z
    .string()
    .max(5000) // well over 50 ids, so the count below gives the message
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(orderIds)
    .optional(),
});
const bulkShipBody = z.object({ ids: orderIds });
// Admins' private notes on an order ("customer called, deliver after 6 pm"); `onSlip` also prints it on the packing slip.
const MAX_NOTES = 100;
const noteBody = z.object({
  text: z.string().trim().min(1, 'Write the note').max(1000, 'At most 1000 characters'),
  onSlip: z.boolean().default(false),
});

const reviewQuery = z.object({
  status: z.enum(['visible', 'hidden', 'flagged']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
const reviewVisibility = z.object({ hidden: z.boolean() });

// How a shipped order travels: the courier, its tracking number and (pasted by the admin) the courier's tracking page.
// All optional, so an order can still be shipped without them and tracking added later.
export const shipmentFields = z
  .object({
    courier: z.string().trim().max(40).default(''),
    trackingNumber: z
      .string()
      .trim()
      .max(40)
      .regex(/^[A-Za-z0-9 -]*$/, 'Use letters, digits, spaces and dashes')
      .default(''),
    // Only http(s) links, since it becomes a link on the customer's order page and in the email.
    trackingUrl: z
      .string()
      .trim()
      .max(500)
      .refine((u) => u === '' || /^https?:\/\/[^\s]+$/i.test(u), 'Paste a link starting with https://')
      .default(''),
  })
  .refine((s) => !s.trackingNumber || s.courier, { message: 'Name the courier', path: ['courier'] });
// A shipped order that came back undelivered (cod.js).
const returnedBody = z.object({
  reason: z.enum(Object.keys(RTO_REASONS), 'Choose why it came back'),
  note: z.string().trim().max(300).default(''),
});
const statusBody = z.object({
  status: z.enum(['shipped', 'delivered', 'cancelled']),
  shipment: shipmentFields.optional(),
});
// Stored only when something was entered.
export const toShipment = (s) => (s && (s.courier || s.trackingNumber || s.trackingUrl) ? s : null);
// Which status each step moves on from. Cancelling also puts the stock back (see cancelOrder).
const NEXT_FROM = { shipped: ['placed'], delivered: ['shipped'], cancelled: ['awaiting_payment', 'placed', 'shipped'] };

const PRODUCT_PAGE = 50;
const ORDER_PAGE = 25;
export const LOW_STOCK = 5;
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
  cost: doc.cost ?? null,
  sizeGuide: doc.sizeGuide ?? null,
  comingSoon: doc.comingSoon ?? null,
  quantityDiscount: doc.quantityDiscount ?? null,
  images: doc.images,
  imageAlts: imageAltsOf(doc),
  active: doc.active,
  // On sale (sales.js): the form shows it and keeps the prices as they are.
  sale: doc.sale ? { name: doc.sale.name, percent: doc.sale.percent, endsAt: doc.sale.endsAt } : null,
  variantName: doc.variants?.length ? doc.variantName : '',
  options: doc.variants?.length ? optionsOf(doc) : [],
  // Admins see each option's cost too (toVariant leaves it out for customers).
  variants: (doc.variants ?? []).map((v) => ({ ...toVariant(v), cost: v.cost ?? null })),
  updatedAt: doc.updatedAt,
});

export const categoryIcon = (category) => category.icon ?? ICONS[category.slug] ?? DEFAULT_ICON;

// What staff below admin may do here (staff.js): see orders and their notes, ship them (one, in bulk, tracking), and
// hide or show reviews. Everything else under /admin is for admins.
const ID = '[0-9a-f]{24}';
const STAFF_ROUTES = [
  ['GET', /^\/orders$/, 'orders.view'],
  ['GET', new RegExp(`^/orders/${ID}$`), 'orders.view'],
  ['POST', new RegExp(`^/orders/${ID}/status$`), 'orders.ship'],
  ['POST', /^\/orders\/ship$/, 'orders.ship'],
  ['PUT', new RegExp(`^/orders/${ID}/shipment$`), 'orders.ship'],
  ['POST', new RegExp(`^/orders/${ID}/notes$`), 'orders.notes'],
  ['DELETE', new RegExp(`^/orders/${ID}/notes/${ID}$`), 'orders.notes'],
  ['GET', /^\/reviews$/, 'reviews'],
  ['POST', new RegExp(`^/reviews/${ID}/visibility$`), 'reviews'],
];

export function adminRouter(ctx) {
  const { db } = ctx;
  const products = db.collection('products');
  const categories = db.collection('categories');
  const orders = db.collection('orders');
  const users = db.collection('users');
  const router = express.Router();

  // Every route below needs an admin. 401 when logged out, 403 for customers.
  router.use('/admin', staffGuard(STAFF_ROUTES));

  async function findCategory(id) {
    const category = await categories.findOne({ _id: new ObjectId(id) });
    if (!category) throw new HttpError(400, 'categoryId: Choose a category');
    return category;
  }

  // Uploads unused for a day are deleted (deleteUnusedImages), so a form left open that long may hold a gone photo.
  async function checkImages(urls) {
    if ((await missingImages(ctx, urls)).length) {
      throw new HttpError(400, 'images: A photo was removed because it went unused for a day. Upload it again.');
    }
  }

  // ---- Diagnostics ----

  // What the server sees of the admin's own request, to learn which address the host's proxies pass on as the
  // visitor's (for limiting login tries per network). Only the caller's own addresses; nothing is stored.
  router.get('/admin/request-info', (req, res) => {
    const header = (name) => req.get(name) ?? null;
    res.json({
      // What the login limit uses, from CLIENT_IP_HEADER when set.
      clientIp: clientIp(req, ctx.config),
      network: networkOf(clientIp(req, ctx.config)),
      ip: req.ip,
      ips: req.ips,
      remoteAddress: req.socket.remoteAddress,
      headers: {
        'x-forwarded-for': header('x-forwarded-for'),
        'cf-connecting-ip': header('cf-connecting-ip'),
        'true-client-ip': header('true-client-ip'),
        'x-real-ip': header('x-real-ip'),
        'x-forwarded-proto': header('x-forwarded-proto'),
      },
    });
  });

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
    // Low: the product, or any one of its variants, has LOW_STOCK or fewer left.
    if (query.status === 'low')
      filter.$and = [{ $or: [{ stock: { $lte: LOW_STOCK } }, { 'variants.stock': { $lte: LOW_STOCK } }] }];
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
    const { variants, variantName, options, ...body } = parse(createProduct, req.body);
    if (!variants.length && body.mrp < body.price) throw new HttpError(400, 'mrp: MRP must be at least the price');
    checkVariantImages(variants, body.images);
    const category = await findCategory(body.categoryId);
    await checkImages(body.images);
    const now = new Date();
    const base = slugify(body.title) || 'product';
    // The slug comes from the title and never changes afterwards, so product links keep working.
    for (let n = 1; n <= 50; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      const doc = {
        ...body,
        ...(variants.length && { ...storedOptions({ variantName, options }), ...storedVariants(variants) }),
        slug,
        categoryId: category._id,
        images: body.images.length ? body.images : [image(slug, categoryIcon(category), body.brand)],
        imageAlts: storedAlts(body.imageAlts, body.images),
        rating: { avg: 0, count: 0 },
        createdAt: now,
        updatedAt: now,
      };
      try {
        const insertedId = await inTransaction(ctx.client, async (session) => {
          const { insertedId } = await products.insertOne(doc, { session });
          await recordStock(
            db,
            savedEntries(null, { ...doc, _id: insertedId }, { reason: 'added', by: byOf(req.user), at: now }),
            session,
          );
          return insertedId;
        });
        await logActivity(db, req.user, {
          area: 'products',
          action: 'Added product',
          target: productTarget({ ...doc, _id: insertedId }),
          changes: [
            { field: 'Category', to: category.name },
            ...(doc.variants?.length
              ? [{ field: 'Variants', to: doc.variants.map((v) => v.label).join(', ') }]
              : [
                  { field: 'Price', to: rupees(doc.price) },
                  { field: 'Stock', to: String(doc.stock) },
                ]),
            { field: 'Shown', to: yesNo(doc.active) },
          ],
        });
        await notePrices(db, { _id: insertedId }); // the price history (stage 112)
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
    const { variants, variantName, options, ...fields } = body;
    const update = { ...fields, updatedAt: new Date() };
    const unset = {};
    if (variants?.length) {
      checkVariantImages(variants, fields.images ?? current.images);
      // The product's price, MRP and stock follow its variants.
      Object.assign(update, {
        ...storedOptions({ variantName, options }),
        ...storedVariants(variants, current.variants),
      });
    } else {
      if (variants === undefined && current.variants?.length && ['price', 'mrp', 'stock'].some((f) => f in fields)) {
        throw new HttpError(400, 'This product has variants: change the price and stock of each one');
      }
      if ((fields.mrp ?? current.mrp) < (fields.price ?? current.price)) {
        throw new HttpError(400, 'mrp: MRP must be at least the price');
      }
      if (variants) Object.assign(unset, { variants: '', variantName: '', options: '' });
      // Photos removed from the product leave its variants too.
      if (fields.images && current.variants?.length && !variants) {
        const own = new Set(fields.images);
        update.variants = current.variants.map((v) => ({ ...v, images: (v.images ?? []).filter((u) => own.has(u)) }));
      }
    }
    // A product on sale keeps its prices until the sale ends (sales.js puts the regular ones back then).
    assertPriceUnchanged(current, { price: update.price, mrp: update.mrp, variants: update.variants });
    if (body.images) await checkImages(body.images);
    if (body.categoryId) update.categoryId = (await findCategory(body.categoryId))._id;
    if (body.images?.length === 0) {
      const category = await categories.findOne({ _id: update.categoryId ?? current.categoryId });
      update.images = [
        image(current.slug, category ? categoryIcon(category) : DEFAULT_ICON, body.brand ?? current.brand),
      ];
    }
    // Descriptions follow the photos: new ones as sent, or the old ones of the photos still there.
    if (fields.imageAlts || fields.images) {
      update.imageAlts = storedAlts(
        fields.imageAlts ?? imageAltsOf(current),
        update.images ?? fields.images ?? current.images,
      );
    }
    // With the product as it really was just before (an order may have taken stock since `current` was read), so the
    // stock history records exactly what this save changed.
    const doc = await inTransaction(ctx.client, async (session) => {
      const before = await products.findOneAndUpdate(
        { _id },
        { $set: update, ...(Object.keys(unset).length && { $unset: unset }) },
        { session },
      );
      const after = await products.findOne({ _id }, { session });
      await recordStock(
        db,
        savedEntries(before, after, { reason: 'edited', by: byOf(req.user), at: update.updatedAt }),
        session,
      );
      return after;
    });
    const names = new Map(
      (await categories.find({ _id: { $in: [current.categoryId, doc.categoryId] } }).toArray()).map((c) => [
        c._id.toString(),
        c.name,
      ]),
    );
    const changes = productChanges(current, doc, (id) => names.get(id.toString()) ?? '');
    if (changes.length) {
      await logActivity(db, req.user, {
        area: 'products',
        action: 'Changed product',
        target: productTarget(doc),
        changes,
      });
    }
    await notePrices(db, { _id: doc._id }); // the price history (stage 112)
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
    await logActivity(db, req.user, {
      area: 'categories',
      action: 'Added category',
      target: { label: doc.name, path: '/admin/categories' },
    });
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
    const changes = [
      ...(current.name !== doc.name ? [{ field: 'Name', from: current.name, to: doc.name }] : []),
      ...(categoryIcon(current) !== categoryIcon(doc)
        ? [{ field: 'Icon', from: categoryIcon(current), to: categoryIcon(doc) }]
        : []),
    ];
    if (changes.length) {
      await logActivity(db, req.user, {
        area: 'categories',
        action: 'Changed category',
        target: { label: doc.name, path: '/admin/categories' },
        changes,
      });
    }
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
    await logActivity(db, req.user, { area: 'categories', action: 'Reordered categories' });
    res.status(204).end();
  });

  router.delete('/admin/categories/:id', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'category id');
    // Hidden products count too: they still belong to the category.
    const count = await products.countDocuments({ categoryId: _id });
    if (count) {
      throw new HttpError(409, `Move or hide its ${count} ${count === 1 ? 'product' : 'products'} first`);
    }
    const deleted = await categories.findOneAndDelete({ _id });
    if (!deleted) throw new HttpError(404, 'Category not found');
    await logActivity(db, req.user, {
      area: 'categories',
      action: 'Deleted category',
      target: { label: deleted.name, path: null },
    });
    res.status(204).end();
  });

  // ---- Orders ----

  async function withCustomers(docs) {
    const people = await users
      .find({ _id: { $in: [...new Set(docs.map((o) => o.userId))] } }, { projection: { name: 1, email: 1, tags: 1 } })
      .toArray();
    const byId = new Map(
      people.map((u) => [u._id.toString(), { id: u._id.toString(), name: u.name, email: u.email, tags: u.tags ?? [] }]),
    );
    return docs.map((o) => ({ ...toOrder(o, { admin: true }), customer: byId.get(o.userId.toString()) ?? null }));
  }

  router.get('/admin/orders', async (req, res) => {
    const query = parse(orderQuery, req.query);
    if (query.ids) {
      const docs = await orders.find({ _id: { $in: query.ids.map((id) => new ObjectId(id)) } }).toArray();
      const byId = new Map(docs.map((d) => [d._id.toString(), d]));
      const found = query.ids.filter((id) => byId.has(id)).map((id) => byId.get(id));
      return res.json({ items: await withCustomers(found), total: found.length, page: 1, pageSize: BULK_ORDERS });
    }
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
    const [order] = await withCustomers([doc]);
    // The customer's own notes (stage 82, Admin → Customers), newest first, for whoever handles the order.
    if (order.customer) {
      const user = await users.findOne({ _id: doc.userId }, { projection: { adminNotes: 1 } });
      order.customer.notes = [...(user?.adminNotes ?? [])].reverse().map(toAdminNote);
    }
    res.json(order);
  });

  // Moves an order on to `status` (shipped, delivered or cancelled): the step's checks, the customer's email and the
  // activity log, for one order or several (bulk shipping). Throws HttpError 404/409 when it can't.
  async function advanceOrder(req, _id, status, shipment) {
    let doc;
    if (status === 'cancelled') {
      doc = await cancelOrder(ctx, { _id }, { from: NEXT_FROM.cancelled, by: 'admin', user: req.user });
    } else {
      const now = new Date();
      // The expected current status is part of the filter, so two admins clicking at once can't skip a step.
      doc = await orders.findOneAndUpdate(
        { _id, status: { $in: NEXT_FROM[status] } },
        {
          $set: {
            status,
            [`${status}At`]: now,
            updatedAt: now,
            ...(status === 'shipped' && toShipment(shipment) && { shipment: toShipment(shipment) }),
          },
        },
        { returnDocument: 'after' },
      );
      if (!doc) {
        const existing = await orders.findOne({ _id });
        if (!existing) throw new HttpError(404, 'Order not found');
        throw new HttpError(409, `A ${existing.status} order can't be marked ${status}`);
      }
      await sendOrderEmail(ctx, doc, status);
    }
    const s = doc.shipment;
    await logActivity(db, req.user, {
      area: 'orders',
      action: status === 'cancelled' ? 'Cancelled' : `Marked ${status}`,
      target: orderTarget(doc),
      changes: [
        ...(status === 'shipped' && s
          ? [{ field: 'Tracking', to: [s.courier, s.trackingNumber].filter(Boolean).join(' ') || s.trackingUrl }]
          : []),
        ...(status === 'cancelled' && doc.payment?.status ? [{ field: 'Payment', to: doc.payment.status }] : []),
      ],
    });
    return doc;
  }

  router.post('/admin/orders/:id/status', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'order id');
    const { status, shipment } = parse(statusBody, req.body);
    // Cancelling can refund money: admins only.
    if (status === 'cancelled' && !can(req.user, 'orders.manage')) {
      throw new HttpError(403, 'Only an admin can cancel an order');
    }
    res.json((await withCustomers([await advanceOrder(req, _id, status, shipment)]))[0]);
  });

  // Returned to sender: the parcel came back undelivered. A cancellation of a shipped order (stock, coupon and store
  // credit back, online payments refunded) that remembers why; refused and unreachable ones count against COD.
  // Admins only (it can refund), as it isn't in STAFF_ROUTES.
  router.post('/admin/orders/:id/returned', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'order id');
    const { reason, note } = parse(returnedBody, req.body);
    const current = await orders.findOne({ _id }, { projection: { status: 1 } });
    if (!current) throw new HttpError(404, 'Order not found');
    if (current.status !== 'shipped') throw new HttpError(409, 'Only a shipped order can come back undelivered');
    const doc = await cancelOrder(
      ctx,
      { _id },
      { from: ['shipped'], by: 'admin', user: req.user, returned: { reason, note } },
    );
    await logActivity(db, req.user, {
      area: 'orders',
      action: 'Returned to sender',
      target: orderTarget(doc),
      changes: [
        { field: 'Reason', to: RTO_REASONS[reason] },
        ...(note ? [{ field: 'Note', to: note }] : []),
        ...(doc.payment?.status ? [{ field: 'Payment', to: doc.payment.status }] : []),
      ],
    });
    res.json((await withCustomers([doc]))[0]);
  });

  router.post('/admin/orders/:id/notes', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'order id');
    const { text, onSlip } = parse(noteBody, req.body);
    const note = { _id: new ObjectId(), text, onSlip, by: { id: req.user._id, name: req.user.name }, at: new Date() };
    const doc = await orders.findOneAndUpdate(
      { _id, [`notes.${MAX_NOTES - 1}`]: { $exists: false } },
      { $push: { notes: note } },
      { returnDocument: 'after' },
    );
    if (!doc) {
      if (!(await orders.findOne({ _id }, { projection: { _id: 1 } }))) throw new HttpError(404, 'Order not found');
      throw new HttpError(409, `An order can have at most ${MAX_NOTES} notes`);
    }
    await logActivity(db, req.user, {
      area: 'orders',
      action: 'Added a note to',
      target: orderTarget(doc),
      changes: [{ field: onSlip ? 'Note (on the packing slip)' : 'Note', to: text }],
    });
    res.status(201).json((await withCustomers([doc]))[0]);
  });

  router.delete('/admin/orders/:id/notes/:noteId', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'order id');
    const noteId = parseObjectId(req.params.noteId, 'note id');
    const before = await orders.findOneAndUpdate(
      { _id, 'notes._id': noteId },
      { $pull: { notes: { _id: noteId } } },
      { returnDocument: 'before' },
    );
    if (!before) throw new HttpError(404, 'Note not found');
    const note = before.notes.find((n) => n._id.equals(noteId));
    await logActivity(db, req.user, {
      area: 'orders',
      action: 'Deleted a note from',
      target: orderTarget(before),
      changes: [{ field: 'Note', from: note.text, to: 'deleted' }],
    });
    res.json((await withCustomers([await orders.findOne({ _id })]))[0]);
  });

  // Marks several placed orders shipped at once (each emailed and logged as if done one by one). Orders that can't be
  // shipped are skipped with the reason; the rest go ahead.
  router.post('/admin/orders/ship', async (req, res) => {
    const { ids } = parse(bulkShipBody, req.body);
    const shipped = [];
    const skipped = [];
    for (const id of ids) {
      try {
        const doc = await advanceOrder(req, new ObjectId(id), 'shipped');
        shipped.push({ id, number: doc.number ?? null });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        const doc = await orders.findOne({ _id: new ObjectId(id) }, { projection: { number: 1 } });
        skipped.push({ id, number: doc?.number ?? null, reason: err.message });
      }
    }
    res.json({ shipped, skipped });
  });

  // Adds or corrects the tracking details of a shipped (or delivered) order; empty fields remove them. No email: the
  // customer sees them on the order page.
  router.put('/admin/orders/:id/shipment', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'order id');
    const shipment = toShipment(parse(shipmentFields, req.body));
    const doc = await orders.findOneAndUpdate(
      { _id, status: { $in: ['shipped', 'delivered'] } },
      shipment
        ? { $set: { shipment, updatedAt: new Date() } }
        : { $unset: { shipment: '' }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!doc) {
      const existing = await orders.findOne({ _id });
      if (!existing) throw new HttpError(404, 'Order not found');
      throw new HttpError(409, `A ${existing.status} order has no shipment to edit`);
    }
    await logActivity(db, req.user, {
      area: 'orders',
      action: 'Changed tracking',
      target: orderTarget(doc),
      changes: [
        {
          field: 'Tracking',
          to: shipment
            ? [shipment.courier, shipment.trackingNumber, shipment.trackingUrl].filter(Boolean).join(' · ')
            : 'removed',
        },
      ],
    });
    res.json((await withCustomers([doc]))[0]);
  });

  // For a cancelled online order whose automatic refund failed (e.g. Razorpay was unreachable).
  router.post('/admin/orders/:id/refund', async (req, res) => {
    const doc = await orders.findOne({ _id: parseObjectId(req.params.id, 'order id') });
    if (!doc) throw new HttpError(404, 'Order not found');
    if (doc.status !== 'cancelled' || doc.payment?.status !== 'refund_failed') {
      throw new HttpError(409, 'Only a cancelled order whose refund failed can be retried');
    }
    const after = await refundPayment(ctx, doc);
    await logActivity(db, req.user, {
      area: 'orders',
      action: 'Retried refund',
      target: orderTarget(after),
      changes: [{ field: 'Refund', to: after.payment?.status ?? '' }],
    });
    res.json((await withCustomers([after]))[0]);
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
      screening: toScreening(r),
      product: product.get(r.productId.toString()) ?? null,
      customer: person.get(r.userId.toString()) ?? null,
    }));
  }

  router.get('/admin/reviews', async (req, res) => {
    const query = parse(reviewQuery, req.query);
    // Flagged by screening (screening.js) and not dealt with yet: newest first like the rest.
    const filter = query.status === 'flagged' ? FLAGGED : query.status ? { hidden: query.status === 'hidden' } : {};
    const [docs, total, counts, flagged] = await Promise.all([
      reviews
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * REVIEW_PAGE)
        .limit(REVIEW_PAGE)
        .toArray(),
      reviews.countDocuments(filter),
      reviews.aggregate([{ $group: { _id: '$hidden', n: { $sum: 1 } } }]).toArray(),
      reviews.countDocuments(FLAGGED),
    ]);
    res.json({
      items: await reviewDetails(docs),
      total,
      page: query.page,
      pageSize: REVIEW_PAGE,
      counts: {
        visible: counts.find((c) => c._id === false)?.n ?? 0,
        hidden: counts.find((c) => c._id === true)?.n ?? 0,
        flagged,
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
        return { ...changed, stateChanged: true };
      }
      return reviews.findOne({ _id }, { session });
    });
    if (!doc) throw new HttpError(404, 'Review not found');
    const [details] = await reviewDetails([doc]);
    if (doc.stateChanged) {
      await logActivity(db, req.user, {
        area: 'reviews',
        action: hidden ? 'Hid review' : 'Showed review',
        target: {
          label: `${details.rating}★ by ${details.author} of ${details.product?.title ?? 'a product'}`,
          path: '/admin/reviews',
        },
      });
    }
    res.json(details);
  });

  return router;
}
