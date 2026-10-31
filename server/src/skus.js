import { z } from 'zod';
import { HttpError } from './http.js';

// SKUs and barcodes (stage 120): the store's own code (`sku`) and the maker's barcode number (`barcode`, an EAN/UPC/
// GTIN of 8, 12, 13 or 14 digits with a valid check digit) on a product and on each of its variants. Both optional,
// admin-only (order items keep the SKU sold, which toOrder gives only to admins), and unique across the store: no two
// products or options share one, whether it's a product's or an option's. SKUs are kept in capitals, so "ab-1" and
// "AB-1" are the same. A USB barcode scanner types the number, so scanning into the admin product search finds it.

export const CODE_KINDS = ['sku', 'barcode'];
const LABEL = { sku: 'SKU', barcode: 'Barcode' };

// '' or null for none.
export const skuField = z
  .string()
  .trim()
  .toUpperCase()
  .max(40, 'An SKU can be at most 40 characters')
  .nullable()
  .transform((s, ctx) => {
    if (!s) return null;
    if (!/^[A-Z0-9][A-Z0-9._/-]*$/.test(s)) {
      ctx.addIssue({ code: 'custom', message: 'An SKU uses letters, digits and - _ . / only' });
      return z.NEVER;
    }
    return s;
  });

// GS1's check digit: from the right, digits weighted 3, 1, 3, 1… (the last digit is the check digit itself).
export function validGtin(digits) {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

export const barcodeField = z
  .string()
  .nullable()
  .transform((s, ctx) => {
    const digits = (s ?? '').replace(/[\s-]/g, '');
    if (!digits) return null;
    if (!validGtin(digits)) {
      ctx.addIssue({ code: 'custom', message: 'A barcode is the 8, 12, 13 or 14 digits under the stripes' });
      return z.NEVER;
    }
    return digits;
  });

// Every code a product (as it will be saved) holds: [{ kind, code, variant (label) | null }].
export function codesOf(doc) {
  const list = [];
  for (const kind of CODE_KINDS) {
    if (doc[kind]) list.push({ kind, code: doc[kind], variant: null });
    for (const v of doc.variants ?? []) if (v[kind]) list.push({ kind, code: v[kind], variant: v.label });
  }
  return list;
}

const nameOf = (title, variant) => (variant ? `${title} (${variant})` : title);

// Refuses (409) a product whose codes repeat within it or are used by another product or option. `self` is the
// product's own id when it's being edited.
export async function assertCodesFree(db, doc, self = null, session) {
  const codes = codesOf(doc);
  const seen = new Set();
  for (const { kind, code } of codes) {
    if (seen.has(`${kind}:${code}`)) throw new HttpError(409, `${LABEL[kind]} ${code} is given twice`);
    seen.add(`${kind}:${code}`);
  }
  for (const kind of CODE_KINDS) {
    const mine = codes.filter((c) => c.kind === kind).map((c) => c.code);
    if (!mine.length) continue;
    const other = await db.collection('products').findOne(
      {
        ...(self && { _id: { $ne: self } }),
        $or: [{ [kind]: { $in: mine } }, { [`variants.${kind}`]: { $in: mine } }],
      },
      { projection: { title: 1, [kind]: 1, 'variants.label': 1, [`variants.${kind}`]: 1 }, session },
    );
    if (other) {
      const taken = mine.includes(other[kind])
        ? { code: other[kind], variant: null }
        : (other.variants ?? [])
            .filter((v) => mine.includes(v[kind]))
            .map((v) => ({ code: v[kind], variant: v.label }))[0];
      throw new HttpError(409, `${LABEL[kind]} ${taken.code} is already used by ${nameOf(other.title, taken.variant)}`);
    }
  }
}

// For the product spreadsheet: which rows would leave a code used twice in the store. `owners` maps an owner key
// ("productId|variantId", or a new product's "new|line") to { name, sku, barcode } as the file would leave them;
// returns [{ owner, message }] for each owner holding a repeated code.
export function repeatedCodes(owners) {
  const users = new Map(); // "kind:code" → [owner keys]
  for (const [owner, codes] of owners) {
    for (const kind of CODE_KINDS) {
      if (!codes[kind]) continue;
      const key = `${kind}:${codes[kind]}`;
      users.set(key, [...(users.get(key) ?? []), owner]);
    }
  }
  const problems = [];
  for (const [key, list] of users) {
    if (list.length < 2) continue;
    const [kind, code] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    for (const owner of list) {
      const others = list.filter((o) => o !== owner).map((o) => owners.get(o).name);
      problems.push({ owner, message: `${LABEL[kind]} ${code} is also used by ${others.join(', ')}` });
    }
  }
  return problems;
}

export { nameOf };
