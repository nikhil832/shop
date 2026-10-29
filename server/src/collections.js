import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { HttpError, parse, parseObjectId } from './http.js';
import { logActivity } from './activity.js';
import { toProductCard } from './routes/catalog.js';
import { slugify } from './seed.js';

// Collections (stage 91): hand-picked product lists with their own page (/c/:slug), for promotions and posts
// ("Diwali gifts", "Under ₹999"). Collection `collections` { name, slug (from the name, unique, never changes),
// description, productIds (in the admin's order), startsAt | null, endsAt | null, onHome, active, position (the home
// page's order), createdAt, updatedAt }. A collection is live while active and between its dates (either may be
// empty); nothing runs on a timer. Live ones with `onHome` are rows on the home page (at most HOME_ROWS, by
// position). Hidden products are left out of pages, not removed. Deleting one only loses the list.
export const MAX_PRODUCTS = 48;
export const HOME_ROWS = 3;
export const HOME_CARDS = 8;

const date = z.union([z.literal(''), z.null(), z.coerce.date('Enter a date and time')]).transform((d) => d || null);
const body = z
  .object({
    name: z.string().trim().min(2, 'Name the collection').max(60, 'At most 60 characters'),
    description: z.string().trim().max(300, 'At most 300 characters').default(''),
    productIds: z
      .array(z.string().regex(/^[0-9a-f]{24}$/, 'Choose products'))
      .min(1, 'Choose at least one product')
      .max(MAX_PRODUCTS, `At most ${MAX_PRODUCTS} products`)
      .refine((ids) => new Set(ids).size === ids.length, 'Each product once'),
    startsAt: date.default(null),
    endsAt: date.default(null),
    onHome: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  .refine((b) => !b.startsAt || !b.endsAt || b.endsAt > b.startsAt, {
    message: 'The end must be after the start',
    path: ['endsAt'],
  });
const moveBody = z.object({ direction: z.enum(['up', 'down']) });

// The filter for collections live at `now`.
export const liveFilter = (now) => ({
  active: true,
  $and: [
    { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
    { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] },
  ],
});
export function collectionStatus(doc, now = new Date()) {
  if (!doc.active) return 'off';
  if (doc.startsAt && doc.startsAt > now) return 'upcoming';
  if (doc.endsAt && doc.endsAt <= now) return 'ended';
  return 'live';
}

// The shown products of each collection, as cards in its order (at most `limit` each).
async function cardsFor(db, docs, limit = MAX_PRODUCTS) {
  const products = new Map(
    (
      await db
        .collection('products')
        .find({ _id: { $in: docs.flatMap((c) => c.productIds) }, active: true })
        .toArray()
    ).map((p) => [p._id.toString(), p]),
  );
  return docs.map((c) =>
    c.productIds
      .map((id) => products.get(id.toString()))
      .filter(Boolean)
      .slice(0, limit)
      .map(toProductCard),
  );
}

const publicView = (doc, items) => ({
  name: doc.name,
  slug: doc.slug,
  description: doc.description,
  endsAt: doc.endsAt,
  items,
});
// "29 Oct 2026, 9:00 am" in India time, for the activity log.
const when = (d) =>
  d ? d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : 'none';

export function collectionsRouter({ db }) {
  const collections = db.collection('collections');
  const products = db.collection('products');
  const router = express.Router();

  // The home page's rows: live collections marked for it, with their first cards; empty ones are skipped.
  router.get('/collections/home', async (req, res) => {
    const docs = await collections
      .find({ ...liveFilter(new Date()), onHome: true })
      .sort({ position: 1, _id: 1 })
      .limit(HOME_ROWS)
      .toArray();
    const cards = await cardsFor(db, docs, HOME_CARDS);
    res.json({ items: docs.map((c, i) => publicView(c, cards[i])).filter((c) => c.items.length) });
  });

  // A collection's page. Not live: 404, except for admins, who can look before it starts (`live: false`).
  router.get('/collections/:slug', async (req, res) => {
    const doc = await collections.findOne({ slug: req.params.slug });
    const live = doc && collectionStatus(doc) === 'live';
    if (!doc || (!live && req.user?.role !== 'admin')) throw new HttpError(404, 'Collection not found');
    const [items] = await cardsFor(db, [doc]);
    res.json({ ...publicView(doc, items), live });
  });

  router.use('/admin/collections', requireAdmin);

  async function checkProducts(ids) {
    const found = await products.countDocuments({ _id: { $in: ids } });
    if (found !== ids.length) throw new HttpError(400, 'productIds: A product no longer exists');
  }

  const toAdmin = async (docs) => {
    const items = new Map(
      (
        await products
          .find({ _id: { $in: docs.flatMap((c) => c.productIds) } }, { projection: { title: 1, price: 1, active: 1 } })
          .toArray()
      ).map((p) => [p._id.toString(), p]),
    );
    const now = new Date();
    return docs.map((c) => ({
      id: c._id.toString(),
      name: c.name,
      slug: c.slug,
      description: c.description,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      onHome: c.onHome,
      active: c.active,
      status: collectionStatus(c, now),
      products: c.productIds.map((id) => {
        const p = items.get(id.toString());
        return {
          id: id.toString(),
          title: p?.title ?? 'A deleted product',
          price: p?.price ?? null,
          shown: Boolean(p?.active),
        };
      }),
    }));
  };
  const log = (req, action, doc, changes = []) =>
    logActivity(db, req.user, {
      area: 'collections',
      action,
      target: { label: doc.name, path: '/admin/collections' },
      changes,
    });

  router.get('/admin/collections', async (req, res) => {
    const docs = await collections.find().sort({ position: 1, _id: 1 }).limit(200).toArray();
    res.json({ items: await toAdmin(docs) });
  });

  router.post('/admin/collections', async (req, res) => {
    const b = parse(body, req.body);
    const productIds = b.productIds.map((id) => new ObjectId(id));
    await checkProducts(productIds);
    const last = await collections.findOne({}, { sort: { position: -1 }, projection: { position: 1 } });
    const now = new Date();
    const base = slugify(b.name) || 'collection';
    // The slug comes from the name and never changes, so shared links keep working; numbered on clashes.
    for (let n = 1; n <= 50; n++) {
      // /collections/home is the home page's rows.
      if (n === 1 && base === 'home') continue;
      const doc = {
        ...b,
        productIds,
        slug: n === 1 ? base : `${base}-${n}`,
        position: (last?.position ?? 0) + 1,
        createdAt: now,
        updatedAt: now,
      };
      try {
        doc._id = (await collections.insertOne(doc)).insertedId;
      } catch (err) {
        if (err.code === 11000) continue;
        throw err;
      }
      await log(req, 'Added collection', doc, [{ field: 'Products', to: String(productIds.length) }]);
      return res.status(201).json((await toAdmin([doc]))[0]);
    }
    throw new HttpError(409, 'Choose another name');
  });

  // Saves the whole form (the slug stays).
  router.put('/admin/collections/:id', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'collection id');
    const b = parse(body, req.body);
    const productIds = b.productIds.map((id) => new ObjectId(id));
    await checkProducts(productIds);
    const before = await collections.findOneAndUpdate(
      { _id },
      { $set: { ...b, productIds, updatedAt: new Date() } },
      { returnDocument: 'before' },
    );
    if (!before) throw new HttpError(404, 'Collection not found');
    const after = { ...before, ...b, productIds };
    const ids = (c) => c.productIds.map(String).join(',');
    const changes = [
      ['Name', before.name, after.name],
      ['Description', before.description, after.description],
      [
        'Products',
        `${before.productIds.length}`,
        ids(before) === ids(after) ? `${before.productIds.length}` : `${after.productIds.length} (list changed)`,
      ],
      ['Starts', when(before.startsAt), when(after.startsAt)],
      ['Ends', when(before.endsAt), when(after.endsAt)],
      ['On the home page', before.onHome ? 'yes' : 'no', after.onHome ? 'yes' : 'no'],
      ['Shown', before.active ? 'yes' : 'no', after.active ? 'yes' : 'no'],
    ]
      .filter(([, from, to]) => from !== to)
      .map(([field, from, to]) => ({ field, from, to }));
    if (changes.length) await log(req, 'Changed collection', after, changes);
    res.json((await toAdmin([after]))[0]);
  });

  // Swaps it with its neighbour in the home page's order.
  router.post('/admin/collections/:id/move', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'collection id');
    const { direction } = parse(moveBody, req.body);
    const doc = await collections.findOne({ _id });
    if (!doc) throw new HttpError(404, 'Collection not found');
    const up = direction === 'up';
    const other = await collections.findOne(
      { position: up ? { $lt: doc.position } : { $gt: doc.position } },
      { sort: { position: up ? -1 : 1 } },
    );
    if (other) {
      await collections.bulkWrite([
        { updateOne: { filter: { _id }, update: { $set: { position: other.position } } } },
        { updateOne: { filter: { _id: other._id }, update: { $set: { position: doc.position } } } },
      ]);
    }
    res.status(204).end();
  });

  router.delete('/admin/collections/:id', async (req, res) => {
    const doc = await collections.findOneAndDelete({ _id: parseObjectId(req.params.id, 'collection id') });
    if (!doc) throw new HttpError(404, 'Collection not found');
    await log(req, 'Deleted collection', doc);
    res.status(204).end();
  });

  return router;
}
