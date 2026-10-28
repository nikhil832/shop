import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { HttpError, parse, parseObjectId } from './http.js';
import { logActivity, rupees } from './activity.js';
import { toProductCard } from './routes/catalog.js';

// Product bundles (stage 83): 2–3 products without sizes or colours, sold together at a bundle price. Collection
// `bundles` { name, productIds, price (paise, for one of each), active, createdAt, updatedAt }; switched off, never
// deleted. The saving is applied by itself whenever the cart holds a full set (the product page's "Add bundle" just
// adds them): the cart quote and POST /orders both call applyBundles(), and an order stores the bundled units as their
// own items at their bundle prices (`bundle` { id, name }, `regularPrice`), so invoices, GST, returns and profit need
// nothing special. The saving is today's prices less the bundle price; a bundle that saves nothing (a sale lowered the
// prices) isn't applied or shown. Coupons apply after it, to the lower subtotal.

export const MIN_ITEMS = 2;
export const MAX_ITEMS = 3;

// How one set's saving is shared by its products: by price, in whole rupees, the rest on the dearest; each share
// below its product's price. `prices` are paise; returns paise per product, in the same order.
export function shareSaving(prices, saving) {
  const total = prices.reduce((s, p) => s + p, 0);
  const shares = prices.map((p) => Math.floor((saving * p) / total / 100) * 100);
  const dearest = prices.indexOf(Math.max(...prices));
  shares[dearest] += saving - shares.reduce((s, x) => s + x, 0);
  return shares;
}

// Splits cart `lines` ([{ productId (string), variantId, qty, price }]) by the `bundles` that apply: each line becomes
// parts [{ qty, price, bundle: { id, name } | null, regularPrice }]. Bundles are applied biggest saving first, each as
// many whole sets as the remaining quantities allow. Returns { parts (by line), applied: [{ id, name, sets, saving }],
// saving }.
export function applyBundles(lines, bundles) {
  const left = new Map();
  const price = new Map();
  for (const l of lines) {
    if (l.variantId || !l.qty) continue;
    left.set(l.productId, (left.get(l.productId) ?? 0) + l.qty);
    price.set(l.productId, l.price);
  }
  const usable = bundles
    .map((b) => {
      const ids = b.productIds.map(String);
      if (!ids.every((id) => price.has(id))) return null;
      const prices = ids.map((id) => price.get(id));
      const saving = prices.reduce((s, p) => s + p, 0) - b.price;
      return saving > 0 ? { b, ids, prices, saving } : null;
    })
    .filter(Boolean)
    .sort((x, y) => y.saving - x.saving);
  const bundled = new Map(); // productId → [{ qty, price, bundle }]
  const applied = [];
  for (const { b, ids, prices, saving } of usable) {
    const sets = Math.min(...ids.map((id) => left.get(id)));
    if (sets < 1) continue;
    const shares = shareSaving(prices, saving);
    ids.forEach((id, i) => {
      left.set(id, left.get(id) - sets);
      const parts = bundled.get(id) ?? [];
      parts.push({ qty: sets, price: prices[i] - shares[i], bundle: { id: b._id.toString(), name: b.name } });
      bundled.set(id, parts);
    });
    applied.push({ id: b._id.toString(), name: b.name, sets, saving: saving * sets });
  }
  const parts = lines.map((l) => {
    const own = l.variantId ? [] : (bundled.get(l.productId) ?? []);
    bundled.delete(l.productId); // a product listed twice gets its bundle parts once
    const inBundles = own.reduce((n, p) => n + p.qty, 0);
    return [
      ...own.map((p) => ({ ...p, regularPrice: l.price })),
      ...(l.qty - inBundles > 0
        ? [{ qty: l.qty - inBundles, price: l.price, bundle: null, regularPrice: l.price }]
        : []),
    ];
  });
  return { parts, applied, saving: applied.reduce((s, a) => s + a.saving, 0) };
}

// The active bundles that could apply to a cart of these products (each wholly in it).
export async function bundlesFor(db, productIds, session) {
  if (!productIds.length) return [];
  const ids = new Set(productIds.map(String));
  const docs = await db
    .collection('bundles')
    .find({ active: true, productIds: { $in: productIds.map((id) => new ObjectId(id)) } }, { session })
    .toArray();
  return docs.filter((b) => b.productIds.every((id) => ids.has(id.toString())));
}

// A product page's bundles: active ones with this product whose products are all shown, simple and saving something.
export async function productBundles(db, productId) {
  const docs = await db.collection('bundles').find({ active: true, productIds: productId }).toArray();
  if (!docs.length) return [];
  const products = new Map(
    (
      await db
        .collection('products')
        .find({ _id: { $in: docs.flatMap((b) => b.productIds) }, active: true })
        .toArray()
    ).map((p) => [p._id.toString(), p]),
  );
  return docs
    .map((b) => {
      const items = b.productIds.map((id) => products.get(id.toString()));
      if (items.some((p) => !p || p.variants?.length)) return null;
      const regular = items.reduce((s, p) => s + p.price, 0);
      if (regular <= b.price) return null;
      return {
        id: b._id.toString(),
        name: b.name,
        price: b.price,
        regular,
        saving: regular - b.price,
        inStock: items.every((p) => p.stock > 0),
        products: items.map(toProductCard),
      };
    })
    .filter(Boolean);
}

const bundleBody = z.object({
  name: z.string().trim().min(2, 'Name the bundle').max(60, 'At most 60 characters'),
  productIds: z
    .array(z.string().regex(/^[0-9a-f]{24}$/, 'Choose products'))
    .min(MIN_ITEMS, `Choose ${MIN_ITEMS} or ${MAX_ITEMS} products`)
    .max(MAX_ITEMS, `Choose ${MIN_ITEMS} or ${MAX_ITEMS} products`)
    .refine((ids) => new Set(ids).size === ids.length, 'Each product once'),
  price: z
    .number('Enter the bundle price')
    .int()
    .min(100)
    .max(100_000_000)
    .refine((n) => n % 100 === 0, 'Whole rupees'),
});
const editBody = z.object({
  name: bundleBody.shape.name.optional(),
  price: bundleBody.shape.price.optional(),
  active: z.boolean().optional(),
});

export function bundlesRouter({ db }) {
  const bundles = db.collection('bundles');
  const products = db.collection('products');
  const router = express.Router();

  // A product page's "Buy together and save" (its own request, as catalog.js and this module would import each other).
  router.get('/products/:slug/bundles', async (req, res) => {
    const product = await products.findOne({ slug: req.params.slug, active: true }, { projection: { _id: 1 } });
    if (!product) throw new HttpError(404, 'Product not found');
    res.json({ items: await productBundles(db, product._id) });
  });

  router.use('/admin/bundles', requireAdmin);

  // Simple products only, all existing, and the bundle must cost less than them now.
  async function checkProducts(productIds, price) {
    const docs = await products.find({ _id: { $in: productIds } }).toArray();
    if (docs.length !== productIds.length) throw new HttpError(400, 'productIds: A product no longer exists');
    const withOptions = docs.find((p) => p.variants?.length);
    if (withOptions) throw new HttpError(400, `productIds: ${withOptions.title} has sizes or colours`);
    const regular = docs.reduce((s, p) => s + p.price, 0);
    if (price >= regular) throw new HttpError(400, `price: Below ${rupees(regular)}, what they cost now`);
    return docs;
  }

  const toAdmin = async (docs) => {
    const items = new Map(
      (
        await products
          .find({ _id: { $in: docs.flatMap((b) => b.productIds) } }, { projection: { title: 1, price: 1, active: 1 } })
          .toArray()
      ).map((p) => [p._id.toString(), p]),
    );
    return docs.map((b) => {
      const list = b.productIds.map((id) => items.get(id.toString()));
      const regular = list.reduce((s, p) => s + (p?.price ?? 0), 0);
      return {
        id: b._id.toString(),
        name: b.name,
        price: b.price,
        active: b.active,
        regular,
        saving: regular - b.price,
        products: list.map((p, i) => ({
          id: b.productIds[i].toString(),
          title: p?.title ?? 'A deleted product',
          price: p?.price ?? null,
          shown: Boolean(p?.active),
        })),
      };
    });
  };

  router.get('/admin/bundles', async (req, res) => {
    const docs = await bundles.find().sort({ active: -1, createdAt: -1 }).limit(200).toArray();
    res.json({ items: await toAdmin(docs) });
  });

  router.post('/admin/bundles', async (req, res) => {
    const body = parse(bundleBody, req.body);
    const productIds = body.productIds.map((id) => new ObjectId(id));
    const docs = await checkProducts(productIds, body.price);
    const now = new Date();
    const doc = { name: body.name, productIds, price: body.price, active: true, createdAt: now, updatedAt: now };
    const { insertedId } = await bundles.insertOne(doc);
    await logActivity(db, req.user, {
      area: 'bundles',
      action: 'Added bundle',
      target: { label: doc.name, path: '/admin/bundles' },
      changes: [
        { field: 'Products', to: productIds.map((id) => docs.find((p) => p._id.equals(id)).title).join(' + ') },
        { field: 'Price', to: rupees(doc.price) },
      ],
    });
    res.status(201).json((await toAdmin([{ ...doc, _id: insertedId }]))[0]);
  });

  // Renames it, changes its price, or switches it on or off.
  router.patch('/admin/bundles/:id', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'bundle id');
    const body = parse(editBody, req.body);
    const current = await bundles.findOne({ _id });
    if (!current) throw new HttpError(404, 'Bundle not found');
    if (body.price !== undefined || body.active) await checkProducts(current.productIds, body.price ?? current.price);
    const doc = await bundles.findOneAndUpdate(
      { _id },
      { $set: { ...body, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    const changes = [
      ['Name', current.name, doc.name],
      ['Price', rupees(current.price), rupees(doc.price)],
      ['Shown', current.active ? 'yes' : 'no', doc.active ? 'yes' : 'no'],
    ]
      .filter(([, from, to]) => from !== to)
      .map(([field, from, to]) => ({ field, from, to }));
    if (changes.length) {
      await logActivity(db, req.user, {
        area: 'bundles',
        action: 'Changed bundle',
        target: { label: doc.name, path: '/admin/bundles' },
        changes,
      });
    }
    res.json((await toAdmin([doc]))[0]);
  });

  return router;
}
