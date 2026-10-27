import { createHash } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { HttpError, parse } from '../http.js';
import { image, slugify } from '../seed.js';
import { variantTotals } from '../variants.js';
import { categoryIcon } from './admin.js';
import { cell } from './orderExport.js';
import { inTransaction } from './reviews.js';
import { logActivity, productChanges } from '../activity.js';

// Products from a spreadsheet: download them all as CSV, edit, upload. An upload is checked first (a preview of what
// each row adds or changes, and the rows with problems), then saved with the same file and the preview's `plan` id:
// all rows in one transaction, and only if the store still gives the same plan (409 otherwise).
//
// A row with a slug updates that product; without one it adds a product. A row with a Variant (its label, "Black / 32")
// changes only that variant's price, MRP and stock. Empty cells keep what's there. Photos, and adding or removing
// variants, stay in the product form. Prices are rupees, as in the order export.

export const MAX_ROWS = 1000;
const MAX_HIGHLIGHTS = 8;

// Column headings, in the downloaded file's order. Uploads match them ignoring case, spaces and "(₹)".
const COLUMNS = [
  ['slug', 'Slug'],
  ['variant', 'Variant'],
  ['title', 'Title'],
  ['brand', 'Brand'],
  ['category', 'Category'],
  ['price', 'Price (₹)'],
  ['mrp', 'MRP (₹)'],
  ['stock', 'Stock'],
  ['active', 'Shown'],
  ['highlights', 'Highlights'],
  ['description', 'Description'],
];
const headingKey = (h) => h.toLowerCase().replace(/\(₹\)|[^a-z]/g, '');
const KEYS = new Map(COLUMNS.map(([key, heading]) => [headingKey(heading), key]));
const HIGHLIGHT_SEPARATOR = ' | ';

// ---- CSV ----

// Rows of cells from CSV text (RFC 4180: quoted cells may hold commas, quotes as "" and line breaks). Excel saves
// with semicolons in some regions, so a first line with semicolons and no commas switches to them.
export function parseCsv(text) {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const sep = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ',';
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        value += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        value += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === sep) {
      row.push(value);
      value = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else {
      value += c;
    }
  }
  if (value !== '' || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

// The export puts ' before text starting with = + - @ (so spreadsheets don't run it); reading it back takes it off.
const unescapeText = (s) => (/^'[=+\-@]/.test(s) ? s.slice(1) : s);

// ---- Reading cells ----

class RowError extends Error {}

function rupeesToPaise(s, what) {
  const clean = s.replace(/^₹\s*/, '').replaceAll(',', '');
  const m = clean.match(/^(\d{1,7})(?:\.(\d{1,2}))?$/);
  if (!m) throw new RowError(`${what} must be an amount in rupees, like 1499 or 1499.50`);
  const paise = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (paise < 100) throw new RowError(`${what} must be at least ₹1`);
  return paise;
}

function stockOf(s) {
  if (!/^\d{1,6}$/.test(s) || Number(s) > 100_000) throw new RowError('Stock must be a whole number from 0 to 100000');
  return Number(s);
}

const YES = ['yes', 'y', 'true', '1', 'shown', 'show'];
const NO = ['no', 'n', 'false', '0', 'hidden', 'hide'];
function shownOf(s) {
  const v = s.toLowerCase();
  if (YES.includes(v)) return true;
  if (NO.includes(v)) return false;
  throw new RowError('Shown must be yes or no');
}

function text(s, max, what) {
  if (s.length > max) throw new RowError(`${what} can be at most ${max} characters`);
  return s;
}

function highlightsOf(s) {
  const list = s
    .split('|')
    .map((h) => h.trim())
    .filter(Boolean);
  if (list.length > MAX_HIGHLIGHTS) throw new RowError(`At most ${MAX_HIGHLIGHTS} highlights, separated by |`);
  if (list.some((h) => h.length > 100)) throw new RowError('Each highlight can be at most 100 characters');
  return list;
}

// ---- The plan ----

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What the file would do to the store, row by row, from the products and categories as they are now. Rows are
// { row (line in the file), slug, variant, title, action: new | update | same | error, changes: [{ field, from, to }],
// error }. `writes` are the database changes for a save. `id` identifies the plan, so a save can check that the store
// hasn't changed since the preview.
// A product in a running sale keeps its prices until it ends (sales.js); stock and the rest can still change.
const onSale = (product) =>
  `"${product.title}" is in the "${product.sale.name}" sale until ${product.sale.endsAt.toISOString().slice(0, 10)}: change its prices after the sale`;

async function makePlan(db, csv, session) {
  const table = parseCsv(csv);
  const [headings = [], ...lines] = table;
  const keys = headings.map((h) => KEYS.get(headingKey(h)) ?? null);
  if (!keys.includes('slug') && !keys.includes('title')) {
    throw new HttpError(400, 'The first row must be the column headings, with at least Slug or Title');
  }
  const ignored = headings.filter((h, i) => h.trim() && !keys[i]);
  const named = lines.map((cells, i) => ({ line: i + 2, cells })).filter(({ cells }) => cells.some((c) => c.trim()));
  if (!named.length) throw new HttpError(400, 'The file has no product rows');
  if (named.length > MAX_ROWS) throw new HttpError(400, `At most ${MAX_ROWS} rows at a time`);

  const categories = await db.collection('categories').find({}, { session }).toArray();
  const categoryOf = (s) => {
    const v = s.toLowerCase();
    const found = categories.find((c) => c.slug === v || c.name.toLowerCase() === v);
    if (!found) throw new RowError(`No category "${s}": use one from Admin → Categories`);
    return found;
  };
  const categoryName = (id) => categories.find((c) => c._id.equals(id))?.name ?? '';
  const slugs = [...new Set(named.map(({ cells }) => (cells[keys.indexOf('slug')] ?? '').trim()).filter(Boolean))];
  const existing = await db
    .collection('products')
    .find({ slug: { $in: slugs } }, { session })
    .toArray();
  const bySlug = new Map(existing.map((p) => [p.slug, p]));

  const rows = [];
  const seen = new Map(); // "slug|variant" → line, for rows given twice
  const updates = new Map(); // slug → { product, set, variants (copy, when changed), rows }
  const inserts = [];

  for (const { line, cells } of named) {
    const get = (key) => {
      const i = keys.indexOf(key);
      return i === -1 ? '' : unescapeText((cells[i] ?? '').trim());
    };
    const row = { row: line, slug: get('slug'), variant: get('variant'), title: get('title'), changes: [] };
    rows.push(row);
    try {
      const price = get('price') && rupeesToPaise(get('price'), 'Price');
      const mrp = get('mrp') && rupeesToPaise(get('mrp'), 'MRP');
      const stock = get('stock') !== '' ? stockOf(get('stock')) : undefined;

      if (!row.slug) {
        if (row.variant) throw new RowError("Give the product's slug for a variant row");
        // A new product: everything a product needs, as in the product form.
        const missing = ['title', 'brand', 'category', 'price', 'mrp', 'stock'].filter((k) => get(k) === '');
        if (missing.length) throw new RowError(`A new product needs ${missing.join(', ')}`);
        if (mrp < price) throw new RowError('MRP must be at least the price');
        const category = categoryOf(get('category'));
        const doc = {
          title: text(get('title'), 150, 'Title'),
          brand: text(get('brand'), 60, 'Brand'),
          categoryId: category._id,
          description: text(get('description'), 5000, 'Description'),
          highlights: highlightsOf(get('highlights')),
          price,
          mrp,
          stock,
          active: get('active') ? shownOf(get('active')) : true,
        };
        row.action = 'new';
        row.changes = [
          { field: 'brand', to: doc.brand },
          { field: 'category', to: category.name },
          { field: 'price', to: price },
          { field: 'mrp', to: mrp },
          { field: 'stock', to: stock },
          ...(doc.active ? [] : [{ field: 'active', to: false }]),
        ];
        inserts.push({ doc, category });
        continue;
      }

      const key = `${row.slug}|${row.variant.toLowerCase()}`;
      if (seen.has(key)) throw new RowError(`Listed twice: see row ${seen.get(key)}`);
      seen.set(key, line);
      const product = bySlug.get(row.slug);
      if (!product) throw new RowError(`No product with the slug "${row.slug}"`);
      row.title = product.title;
      const update = updates.get(row.slug) ?? { product, set: {}, variants: null, rows: [] };
      updates.set(row.slug, update);
      update.rows.push(row);

      if (row.variant) {
        // A variant row: only its price, MRP and stock.
        const variants = update.variants ?? product.variants?.map((v) => ({ ...v }));
        const v = variants?.find((x) => x.label.toLowerCase() === row.variant.toLowerCase());
        if (!v) {
          throw new RowError(
            product.variants?.length
              ? `"${product.title}" has no variant "${row.variant}"`
              : `"${product.title}" has no sizes or colours: leave Variant empty`,
          );
        }
        row.variant = v.label;
        const next = { price: price || v.price, mrp: mrp || v.mrp, stock: stock ?? v.stock };
        if (next.mrp < next.price) throw new RowError('MRP must be at least the price');
        if (product.sale && (next.price !== v.price || next.mrp !== v.mrp)) throw new RowError(onSale(product));
        for (const field of ['price', 'mrp', 'stock']) {
          if (next[field] !== v[field]) row.changes.push({ field, from: v[field], to: next[field] });
        }
        Object.assign(v, next);
        update.variants = variants;
      } else {
        if (product.variants?.length && (price || mrp || stock !== undefined)) {
          throw new RowError('This product has sizes or colours: change the price and stock on its variant rows');
        }
        const next = {};
        if (get('title')) next.title = text(get('title'), 150, 'Title');
        if (get('brand')) next.brand = text(get('brand'), 60, 'Brand');
        if (get('category')) next.categoryId = categoryOf(get('category'))._id;
        if (get('description')) next.description = text(get('description'), 5000, 'Description');
        if (get('highlights')) next.highlights = highlightsOf(get('highlights'));
        if (product.sale && ((price && price !== product.price) || (mrp && mrp !== product.mrp))) {
          throw new RowError(onSale(product));
        }
        if (price) next.price = price;
        if (mrp) next.mrp = mrp;
        if (stock !== undefined) next.stock = stock;
        if (get('active')) next.active = shownOf(get('active'));
        if ((next.mrp ?? product.mrp) < (next.price ?? product.price)) {
          throw new RowError('MRP must be at least the price');
        }
        for (const [field, to] of Object.entries(next)) {
          const from = product[field] ?? (field === 'highlights' ? [] : '');
          if (field === 'categoryId') {
            if (!to.equals(from)) {
              row.changes.push({ field: 'category', from: categoryName(from), to: categoryName(to) });
              update.set.categoryId = to;
            }
          } else if (!same(from, to)) {
            row.changes.push({ field, from, to });
            update.set[field] = to;
          }
        }
      }
      row.action = row.changes.length ? 'update' : 'same';
    } catch (err) {
      if (!(err instanceof RowError)) throw err;
      row.action = 'error';
      row.error = err.message;
      row.changes = [];
    }
  }

  const writes = { inserts, updates: [...updates.values()].filter((u) => u.rows.some((r) => r.action === 'update')) };
  const summary = Object.fromEntries(
    ['new', 'update', 'same', 'error'].map((a) => [a, rows.filter((r) => r.action === a).length]),
  );
  const id = createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 32);
  return { id, rows, summary, ignored, writes };
}

// The first free slug for a new product's title: title, title-2, … (like the product form), not taken in the store
// nor earlier in this import.
async function freeSlug(products, title, taken, session) {
  const base = slugify(title) || 'product';
  for (let n = 1; n <= 50; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(slug) && !(await products.findOne({ slug }, { projection: { _id: 1 }, session }))) {
      taken.add(slug);
      return slug;
    }
  }
  throw new HttpError(409, `Too many products called "${title}"`);
}

const planQuery = z.object({ plan: z.string().regex(/^[0-9a-f]{32}$/, 'Check the file first') });

export function productImportRouter(ctx) {
  const { db } = ctx;
  const products = db.collection('products');
  const router = express.Router();
  router.use('/admin/products/import', requireAdmin);
  router.use('/admin/products/export', requireAdmin);
  // The file as it was chosen, up to 1 MB (about 5,000 rows; at most MAX_ROWS are taken).
  const csvBody = express.text({ type: () => true, limit: '1mb' });
  const csvOf = (req) => {
    if (typeof req.body !== 'string' || !req.body.trim()) throw new HttpError(400, 'Choose a CSV file');
    return req.body;
  };

  // Every product, shown or hidden, by title; a product with variants is followed by one row per variant.
  router.get('/admin/products/export', async (req, res) => {
    const [docs, categories] = await Promise.all([
      products.find().sort({ title: 1, _id: 1 }).toArray(),
      db.collection('categories').find().toArray(),
    ]);
    const categoryName = new Map(categories.map((c) => [c._id.toString(), c.name]));
    const rupees = (paise) => (paise / 100).toFixed(2);
    const lines = [COLUMNS.map(([, heading]) => cell(heading)).join(',')];
    for (const p of docs) {
      const hasVariants = p.variants?.length > 0;
      lines.push(
        [
          cell(p.slug),
          '',
          cell(p.title, { text: true }),
          cell(p.brand, { text: true }),
          cell(categoryName.get(p.categoryId.toString()) ?? '', { text: true }),
          hasVariants ? '' : rupees(p.price),
          hasVariants ? '' : rupees(p.mrp),
          hasVariants ? '' : p.stock,
          p.active ? 'yes' : 'no',
          cell((p.highlights ?? []).join(HIGHLIGHT_SEPARATOR), { text: true }),
          cell(p.description ?? '', { text: true }),
        ].join(','),
      );
      for (const v of p.variants ?? []) {
        lines.push(
          [
            cell(p.slug),
            cell(v.label, { text: true }),
            cell(p.title, { text: true }),
            '',
            '',
            rupees(v.price),
            rupees(v.mrp),
            v.stock,
            '',
            '',
            '',
          ].join(','),
        );
      }
    }
    const day = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="products-${day}.csv"`,
      'Cache-Control': 'no-store',
    });
    res.send(`\uFEFF${lines.join('\r\n')}\r\n`);
  });

  // The preview: what each row would do. Nothing is saved.
  router.post('/admin/products/import', csvBody, async (req, res) => {
    const { id, rows, summary, ignored } = await makePlan(db, csvOf(req));
    res.json({ plan: id, rows, summary, ignored });
  });

  // Saves the file previewed as `plan`: every row or none.
  router.post('/admin/products/import/save', csvBody, async (req, res) => {
    const { plan } = parse(planQuery, req.query);
    const csv = csvOf(req);
    // What was saved, for the activity log: each product added, and each change by product.
    const logged = [];
    const result = await inTransaction(ctx.client, async (session) => {
      logged.length = 0; // a retried transaction starts again
      const { id, summary, writes } = await makePlan(db, csv, session);
      if (id !== plan) {
        throw new HttpError(409, 'The products changed since you checked the file. Check it again before saving.');
      }
      if (summary.error) throw new HttpError(400, 'Fix the rows with problems first');
      if (!writes.inserts.length && !writes.updates.length) throw new HttpError(400, 'Nothing in the file changes');
      const now = new Date();
      const taken = new Set();
      const categoryNames = new Map(
        (await db.collection('categories').find({}, { session }).toArray()).map((c) => [c._id.toString(), c.name]),
      );
      const categoryName = (id) => categoryNames.get(id.toString()) ?? '';
      for (const { doc, category } of writes.inserts) {
        const slug = await freeSlug(products, doc.title, taken, session);
        logged.push({ field: doc.title, to: `added in ${category.name}` });
        await products.insertOne(
          {
            ...doc,
            slug,
            images: [image(slug, categoryIcon(category), doc.brand)],
            rating: { avg: 0, count: 0 },
            createdAt: now,
            updatedAt: now,
          },
          { session },
        );
      }
      for (const { product, set, variants } of writes.updates) {
        // Variant stock and the product's totals change together (the variants invariant).
        const $set = { ...set, ...(variants && { variants, ...variantTotals(variants) }), updatedAt: now };
        await products.updateOne({ _id: product._id }, { $set }, { session });
        for (const c of productChanges(product, { ...product, ...$set }, categoryName)) {
          logged.push({ ...c, field: `${product.title}: ${c.field}` });
        }
      }
      return { added: writes.inserts.length, updated: writes.updates.length };
    });
    await logActivity(db, req.user, {
      area: 'products',
      action: `Imported products from a CSV file: ${result.added} added, ${result.updated} updated`,
      changes: logged,
    });
    res.json(result);
  });

  return router;
}
