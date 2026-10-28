import express from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireAdmin } from './auth.js';
import { HttpError, parse, parseObjectId } from './http.js';
import { logActivity } from './activity.js';

// Size guides (stage 88): size charts shown from a product page's "Size guide" link. Collection `sizeGuides`
// { name, columns, rows (cells, as many as columns), note, categoryIds, updatedAt }. A product uses its own
// `sizeGuide` (a guide's id, or 'none' to show nothing), else the guide of its category. Admins type the table one row
// per line, cells separated by commas, the first line being the headings.

export const MAX_COLUMNS = 8;
export const MAX_ROWS = 40;

// The table from what an admin typed: lines of comma-separated cells (or tabs, pasted from a spreadsheet).
export function parseTable(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(l.includes('\t') ? '\t' : ',').map((c) => c.trim()));
  if (lines.length < 2) throw new HttpError(400, 'table: A line of headings and at least one row');
  const [columns, ...rows] = lines;
  if (columns.length > MAX_COLUMNS) throw new HttpError(400, `table: At most ${MAX_COLUMNS} columns`);
  if (rows.length > MAX_ROWS) throw new HttpError(400, `table: At most ${MAX_ROWS} rows`);
  const bad = rows.findIndex((r) => r.length !== columns.length);
  if (bad !== -1) {
    throw new HttpError(
      400,
      `table: Row ${bad + 1} has ${rows[bad].length} cells; the headings have ${columns.length}`,
    );
  }
  if ([columns, ...rows].flat().some((c) => c.length > 40))
    throw new HttpError(400, 'table: At most 40 characters a cell');
  return { columns, rows };
}

const guideBody = z.object({
  name: z.string().trim().min(2, 'Name the guide').max(60),
  table: z.string().max(10_000),
  note: z.string().trim().max(300).default(''),
  categoryIds: z
    .array(z.string().regex(/^[0-9a-f]{24}$/))
    .max(50)
    .default([]),
});

const toGuide = (doc) => ({
  id: doc._id.toString(),
  name: doc.name,
  columns: doc.columns,
  rows: doc.rows,
  note: doc.note,
  categoryIds: doc.categoryIds.map(String),
});

// The guide for a product: its own, none, or its category's.
export async function guideFor(db, product) {
  if (product.sizeGuide === 'none') return null;
  const guides = db.collection('sizeGuides');
  if (product.sizeGuide) return guides.findOne({ _id: new ObjectId(product.sizeGuide) });
  return guides.findOne({ categoryIds: product.categoryId });
}

export function sizeGuidesRouter({ db }) {
  const guides = db.collection('sizeGuides');
  const router = express.Router();

  router.get('/products/:slug/size-guide', async (req, res) => {
    const product = await db
      .collection('products')
      .findOne({ slug: req.params.slug, active: true }, { projection: { categoryId: 1, sizeGuide: 1 } });
    if (!product) throw new HttpError(404, 'Product not found');
    const guide = await guideFor(db, product);
    res.json({ guide: guide && toGuide(guide) });
  });

  router.use('/admin/size-guides', requireAdmin);

  router.get('/admin/size-guides', async (req, res) => {
    const docs = await guides.find().sort({ name: 1 }).toArray();
    res.json({ items: docs.map(toGuide) });
  });

  // A category has one guide: giving it to this one takes it from any other.
  async function save(req, _id) {
    const body = parse(guideBody, req.body);
    const table = parseTable(body.table);
    const categoryIds = [...new Set(body.categoryIds)].map((id) => new ObjectId(id));
    const doc = { name: body.name, ...table, note: body.note, categoryIds, updatedAt: new Date() };
    await guides.updateMany(
      { _id: { $ne: _id }, categoryIds: { $in: categoryIds } },
      { $pull: { categoryIds: { $in: categoryIds } } },
    );
    const saved = await guides.findOneAndUpdate({ _id }, { $set: doc }, { upsert: true, returnDocument: 'after' });
    await logActivity(db, req.user, {
      area: 'products',
      action: req.method === 'POST' ? 'Added size guide' : 'Changed size guide',
      target: { label: saved.name, path: '/admin/size-guides' },
      changes: [{ field: 'Table', to: `${table.columns.length} columns, ${table.rows.length} rows` }],
    });
    return saved;
  }

  router.post('/admin/size-guides', async (req, res) => {
    res.status(201).json(toGuide(await save(req, new ObjectId())));
  });

  router.put('/admin/size-guides/:id', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'size guide id');
    if (!(await guides.findOne({ _id }, { projection: { _id: 1 } }))) throw new HttpError(404, 'Size guide not found');
    res.json(toGuide(await save(req, _id)));
  });

  // Products pointing at it go back to their category's guide.
  router.delete('/admin/size-guides/:id', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'size guide id');
    const doc = await guides.findOneAndDelete({ _id });
    if (!doc) throw new HttpError(404, 'Size guide not found');
    await db.collection('products').updateMany({ sizeGuide: _id.toString() }, { $unset: { sizeGuide: '' } });
    await logActivity(db, req.user, {
      area: 'products',
      action: 'Deleted size guide',
      target: { label: doc.name, path: '/admin/size-guides' },
    });
    res.status(204).end();
  });

  return router;
}
