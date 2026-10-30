import { optionsOf, valuesOf } from './variants.js';

// Shop by size (stage 109): products whose options include a size (an option called Size or Waist) can be filtered
// by it on search, showing only those with that size in stock. `size` is a comma-separated list of values ("UK 8",
// "M", "32"). The filter looks for an in-stock variant having one of them among its option values (a colour is never
// called "UK 8" or "32", so which option the value belongs to isn't checked); the facet lists the sizes in stock among
// the products matching everything else, with how many products have each.
export const SIZE_OPTION = /^(size|waist)$/i;
const MAX_SCANNED = 2000;

export const parseSizes = (text) =>
  [
    ...new Set(
      (text ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);

// Only products with an in-stock variant in one of `sizes` (variants from before stage 24 have just a `label`).
export const sizeFilter = (sizes) => ({
  variants: {
    $elemMatch: { stock: { $gt: 0 }, $or: [{ values: { $in: sizes } }, { label: { $in: sizes } }] },
  },
});

const LETTERS = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '3XL', '4XL'];
// Letter sizes in their order, then by the number in them (shoe sizes "UK 7" … "UK 10" by their prefix first, waists
// "28" … "36"), then by name.
export function sortSizes(names) {
  const key = (name) => {
    const letter = LETTERS.indexOf(name.toUpperCase());
    if (letter >= 0) return [0, '', letter, name];
    const number = name.match(/\d+(\.\d+)?/);
    if (number) return [1, name.slice(0, number.index).trim().toLowerCase(), Number(number[0]), name];
    return [2, '', 0, name.toLowerCase()];
  };
  return [...names].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  });
}

// The sizes in stock among products matching `filter`, each with how many products have it, in size order.
export async function sizeFacet(products, filter) {
  const docs = await products
    .find(
      { ...filter, 'variants.0': { $exists: true } },
      { projection: { options: 1, variantName: 1, 'variants.values': 1, 'variants.label': 1, 'variants.stock': 1 } },
    )
    .limit(MAX_SCANNED)
    .toArray();
  const counts = new Map();
  for (const p of docs) {
    const indexes = optionsOf(p)
      .map((name, i) => (SIZE_OPTION.test(name) ? i : -1))
      .filter((i) => i >= 0);
    if (!indexes.length) continue;
    const own = new Set();
    for (const v of p.variants) {
      if (v.stock <= 0) continue;
      for (const i of indexes) if (valuesOf(v)[i]) own.add(valuesOf(v)[i]);
    }
    for (const size of own) counts.set(size, (counts.get(size) ?? 0) + 1);
  }
  return sortSizes([...counts.keys()]).map((name) => ({ name, count: counts.get(name) }));
}
