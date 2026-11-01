import { z } from 'zod';
import { escapeRegex } from './http.js';

// Filter by specification (stage 138): `GET /products?spec=RAM:8 GB&spec=RAM:12 GB&spec=Storage:256 GB` keeps
// products with RAM 8 GB or 12 GB, and Storage 256 GB (values of one name are alternatives, names must all match),
// comparing names and values ignoring case. Each choice is "Name:Value", split at the first colon (names can't hold
// one, specs.js). The facet (`specFacet`) lists, for the products matching everything else, the specification names
// most of them share with their values and counts; each name's counts ignore that name's own choices (like the brand
// facet), so other values stay selectable.
export const MAX_CHOICES = 20;
export const MAX_FACET_NAMES = 6;
export const MAX_FACET_VALUES = 12;
const MAX_SCANNED = 2000;

const choice = z
  .string()
  .max(150)
  .refine((s) => s.includes(':') && s.indexOf(':') > 0 && s.slice(s.indexOf(':') + 1).trim(), {
    message: 'spec: Use Name:Value',
  });
export const specQuery = z
  .union([choice, z.array(choice).max(MAX_CHOICES, `spec: At most ${MAX_CHOICES} choices`)])
  .optional()
  .transform((v) => (v === undefined ? [] : [v].flat()));

const key = (s) => s.trim().toLowerCase();

// The choices by name: Map(name key → { name, values: Map(value key → value) }).
export function specChoices(list) {
  const byName = new Map();
  for (const item of list) {
    const at = item.indexOf(':');
    const name = item.slice(0, at).trim();
    const value = item.slice(at + 1).trim();
    if (!byName.has(key(name))) byName.set(key(name), { name, values: new Map() });
    byName.get(key(name)).values.set(key(value), value);
  }
  return byName;
}

const exactly = (s) => new RegExp(`^${escapeRegex(s.trim())}$`, 'i');
// One condition per chosen name, for `$and`.
export const specConditions = (choices) =>
  [...choices.values()].map((c) => ({
    specs: { $elemMatch: { name: exactly(c.name), value: { $in: [...c.values.values()].map(exactly) } } },
  }));

// Whether a product's specs satisfy the choice for one name.
const satisfies = (doc, c) => (doc.specs ?? []).some((s) => key(s.name) === key(c.name) && c.values.has(key(s.value)));

// The most used spelling in a Map(spelling → count).
const spelling = (counts) => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
const byNumber = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// [{ name, values: [{ value, count, chosen }] }] over products matching `filter` (everything but the spec choices):
// names that at least two products have, with 2 to MAX_FACET_VALUES different values, the most shared first (at most
// MAX_FACET_NAMES); values in number order. Chosen values are always listed, so they can be unticked.
export async function specFacet(products, filter, choices) {
  const docs = await products
    .find({ ...filter, 'specs.0': { $exists: true } }, { projection: { specs: 1 } })
    .limit(MAX_SCANNED)
    .toArray();
  const names = new Map(); // name key → { spellings, products, values: Map(value key → { spellings, docs }) }
  for (const doc of docs) {
    for (const s of doc.specs) {
      const n = key(s.name);
      if (!names.has(n)) names.set(n, { spellings: new Map(), products: 0, values: new Map() });
      const entry = names.get(n);
      entry.spellings.set(s.name, (entry.spellings.get(s.name) ?? 0) + 1);
      entry.products += 1;
      const v = key(s.value);
      if (!entry.values.has(v)) entry.values.set(v, { spellings: new Map(), docs: [] });
      const value = entry.values.get(v);
      value.spellings.set(s.value, (value.spellings.get(s.value) ?? 0) + 1);
      value.docs.push(doc);
    }
  }
  const shown = [...names]
    .filter(([n, e]) => choices.has(n) || (e.products >= 2 && e.values.size >= 2 && e.values.size <= MAX_FACET_VALUES))
    .sort((a, b) => b[1].products - a[1].products || a[0].localeCompare(b[0]))
    .slice(0, MAX_FACET_NAMES);
  return shown.map(([n, e]) => {
    // Products counted for this name: those matching the other names' choices.
    const others = [...choices].filter(([c]) => c !== n).map(([, c]) => c);
    const counted = (doc) => others.every((c) => satisfies(doc, c));
    const chosen = choices.get(n)?.values ?? new Map();
    const values = [...e.values].map(([v, entry]) => ({
      value: spelling(entry.spellings),
      count: entry.docs.filter(counted).length,
      chosen: chosen.has(v),
    }));
    for (const [v, value] of chosen) if (!e.values.has(v)) values.push({ value, count: 0, chosen: true });
    return { name: spelling(e.spellings), values: values.sort((a, b) => byNumber.compare(a.value, b.value)) };
  });
}
