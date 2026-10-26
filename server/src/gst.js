// GST on invoices (stage 38). Prices already include GST, so nothing a customer pays changes: an order placed while
// GST is on remembers the store's details and each item's rate and HSN code (`order.gst`, `items[].gstRate/hsn`), and
// its invoice splits every line into the taxable value and the tax: CGST + SGST when the store and the delivery address
// are in the same state, IGST otherwise. Orders from before (or with GST off) have no `gst` and invoices as before.

// States and union territories with their GST state codes (the first two digits of a GSTIN). The client keeps the
// names in client/src/states.js (a test checks they match).
export const INDIAN_STATES = [
  ['01', 'Jammu and Kashmir'],
  ['02', 'Himachal Pradesh'],
  ['03', 'Punjab'],
  ['04', 'Chandigarh'],
  ['05', 'Uttarakhand'],
  ['06', 'Haryana'],
  ['07', 'Delhi'],
  ['08', 'Rajasthan'],
  ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'],
  ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'],
  ['13', 'Nagaland'],
  ['14', 'Manipur'],
  ['15', 'Mizoram'],
  ['16', 'Tripura'],
  ['17', 'Meghalaya'],
  ['18', 'Assam'],
  ['19', 'West Bengal'],
  ['20', 'Jharkhand'],
  ['21', 'Odisha'],
  ['22', 'Chhattisgarh'],
  ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu'],
  ['27', 'Maharashtra'],
  ['29', 'Karnataka'],
  ['30', 'Goa'],
  ['31', 'Lakshadweep'],
  ['32', 'Kerala'],
  ['33', 'Tamil Nadu'],
  ['34', 'Puducherry'],
  ['35', 'Andaman and Nicobar Islands'],
  ['36', 'Telangana'],
  ['37', 'Andhra Pradesh'],
  ['38', 'Ladakh'],
].map(([code, name]) => ({ code, name }));

// Letters only, lower case, "&" as "and": "Tamil Nadu", "tamilnadu" and "TAMIL-NADU" are one key.
const stateKey = (s) =>
  s
    .toLowerCase()
    .replaceAll('&', 'and')
    .replace(/[^a-z]/g, '');
// Older or common names people type.
const ALIASES = {
  orissa: 'Odisha',
  pondicherry: 'Puducherry',
  uttaranchal: 'Uttarakhand',
  newdelhi: 'Delhi',
  nctofdelhi: 'Delhi',
  nationalcapitalterritoryofdelhi: 'Delhi',
  jandk: 'Jammu and Kashmir',
  andamanandnicobar: 'Andaman and Nicobar Islands',
  dadraandnagarhaveli: 'Dadra and Nagar Haveli and Daman and Diu',
  damananddiu: 'Dadra and Nagar Haveli and Daman and Diu',
};
const BY_KEY = new Map([
  ...INDIAN_STATES.map((s) => [stateKey(s.name), s]),
  ...Object.entries(ALIASES).map(([key, name]) => [key, INDIAN_STATES.find((s) => s.name === name)]),
]);

// The state or union territory a typed name means ({ code, name }), or null.
export const findState = (typed) => BY_KEY.get(stateKey(typed ?? '')) ?? null;

// Rates in use since GST 2.0 (22 September 2025): 5% and 18% for most goods, 40% for a few, 0% exempt, and the
// special 0.25% and 3% (stones, gold and silver). Which applies to a product is for the store's accountant to say.
export const GST_RATES = [0, 0.25, 3, 5, 18, 40];

// GSTIN: state code, PAN (5 letters, 4 digits, a letter), entity number, Z, and a check character (base 36).
const GSTIN = /^(\d{2})[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = BASE36.indexOf(first14[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return BASE36[(36 - (sum % 36)) % 36];
}
// Why a GSTIN is wrong, or null when it looks right (format, check character, a known state code).
export function gstinProblem(gstin) {
  const m = gstin.match(GSTIN);
  if (!m) return 'A GSTIN is 15 characters, like 29ABCDE1234F1Z5';
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14])
    return 'This GSTIN has a typo (its last character doesn’t match)';
  if (!INDIAN_STATES.some((s) => s.code === m[1])) return `${m[1]} is not a state code`;
  return null;
}

// ---- Settings ----

// The `settings` document: { enabled, gstin, legalName, address, state, defaultRate }; categories hold their own
// `gst: { rate, hsn }` (no rate: the default).
export const GST_SETTINGS = 'gst';

// What an order placed now remembers, or null while GST is off: the store's details plus, per category id, the rate and
// HSN code of its products.
export async function gstForOrders(db, session) {
  const settings = await db.collection('settings').findOne({ _id: GST_SETTINGS }, { session });
  if (!settings?.enabled) return null;
  const categories = await db
    .collection('categories')
    .find({}, { projection: { gst: 1 }, session })
    .toArray();
  const byCategory = new Map(
    categories.map((c) => [c._id.toString(), { rate: c.gst?.rate ?? settings.defaultRate, hsn: c.gst?.hsn ?? '' }]),
  );
  return {
    store: {
      gstin: settings.gstin,
      legalName: settings.legalName,
      address: settings.address,
      state: settings.state,
      stateCode: findState(settings.state).code,
    },
    forCategory: (id) => byCategory.get(id.toString()) ?? { rate: settings.defaultRate, hsn: '' },
  };
}

// ---- The invoice ----

// Splits `total` (paise) over `weights` in proportion, in whole paise that add up exactly (largest remainders).
function prorate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    parts[i] += 1;
    left -= 1;
  }
  return parts;
}

// A tax-inclusive amount (paise) at `rate` % as its taxable value and tax, with CGST/SGST halves or IGST.
function split(value, rate, intraState) {
  const taxable = Math.round((value * 100) / (100 + rate));
  const tax = value - taxable;
  const cgst = intraState ? Math.floor(tax / 2) : 0;
  return { value, taxable, tax, cgst, sgst: intraState ? tax - cgst : 0, igst: intraState ? 0 : tax };
}

// The GST lines of an order placed with GST on, or null. Coupon discounts lower the items' values in proportion
// (a free-delivery coupon lowers the delivery), delivery is taxed at the highest item rate (it goes with the goods),
// and the lines add up to the order's total.
export function gstInvoice(order) {
  if (!order.gst) return null;
  const store = order.gst;
  const place = findState(order.address.state);
  const intraState = Boolean(place && place.code === store.stateCode);
  const freeDelivery = order.coupon?.type === 'free_delivery';
  const itemValues = order.items.map((i) => i.price * i.qty);
  const itemDiscounts = freeDelivery ? itemValues.map(() => 0) : prorate(order.discount ?? 0, itemValues);
  const lines = order.items.map((item, i) => ({
    title: item.title,
    hsn: item.hsn ?? '',
    rate: item.gstRate ?? 0,
    qty: item.qty,
    ...split(itemValues[i] - itemDiscounts[i], item.gstRate ?? 0, intraState),
  }));
  const delivery = (order.delivery ?? 0) - (freeDelivery ? (order.discount ?? 0) : 0);
  if (delivery > 0) {
    lines.push({
      title: 'Delivery',
      hsn: '',
      rate: store.deliveryRate,
      qty: 1,
      ...split(delivery, store.deliveryRate, intraState),
    });
  }
  const sum = (list, key) => list.reduce((n, l) => n + l[key], 0);
  const rates = [...new Set(lines.map((l) => l.rate))].sort((a, b) => a - b);
  const byRate = rates.map((rate) => {
    const at = lines.filter((l) => l.rate === rate);
    return { rate, taxable: sum(at, 'taxable'), cgst: sum(at, 'cgst'), sgst: sum(at, 'sgst'), igst: sum(at, 'igst') };
  });
  return {
    seller: { legalName: store.legalName, address: store.address, gstin: store.gstin, state: store.state },
    placeOfSupply: place ? { name: place.name, code: place.code } : { name: order.address.state, code: null },
    intraState,
    lines,
    byRate,
    totals: {
      taxable: sum(lines, 'taxable'),
      cgst: sum(lines, 'cgst'),
      sgst: sum(lines, 'sgst'),
      igst: sum(lines, 'igst'),
      tax: sum(lines, 'tax'),
      value: sum(lines, 'value'),
    },
  };
}
