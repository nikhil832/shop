import { z } from 'zod';

// Quantity discounts (stage 99): a product may have `quantityDiscount` { minQty, percent } ("Buy 3 or more, 10% off
// each"), set in the admin form; null for none. It counts every unit of the product in the cart, whatever its size or
// colour, except units already in a bundle (bundles.js, applied first; a bundle's price is its own deal), and once
// there are minQty of them each of those units costs `percent` less, the saving rounded down to whole rupees so bill
// lines add up. The cart quote and POST /orders both call applyQuantityDiscounts() after applyBundles(); an order
// keeps the discounted units at their lower price with `regularPrice` and `quantityDiscount`, so invoices, GST,
// returns and profit need nothing else, and `quantitySaving` for display (`subtotal` is already after it). A sale
// lowers the price the percentage is taken from. Coupons apply after it, to the lower subtotal.
export const MIN_QTY = 2;
export const MAX_QTY = 50;
export const MAX_PERCENT = 50;

export const quantityDiscountField = z
  .object({
    minQty: z.number('Enter how many').int().min(MIN_QTY, `At least ${MIN_QTY}`).max(MAX_QTY, `At most ${MAX_QTY}`),
    percent: z
      .number('Enter the percentage')
      .int('Whole percentages only')
      .min(1, 'At least 1%')
      .max(MAX_PERCENT, `At most ${MAX_PERCENT}%`),
  })
  .nullable();

// What one unit at `price` (paise) saves at `percent`: whole rupees, rounded down.
export const unitSaving = (price, percent) => Math.floor((price * percent) / 10_000) * 100;

// Applies the products' offers (`offers`: Map productId string → { minQty, percent } | null) to `parts`
// ([{ productId (string), qty, price, bundle }]). Returns { parts (the same order; discounted ones with a lower
// `price`, `regularPrice` and `quantityDiscount`), saving }.
export function applyQuantityDiscounts(parts, offers) {
  const units = new Map();
  for (const p of parts) {
    if (!p.bundle && offers.get(p.productId)) units.set(p.productId, (units.get(p.productId) ?? 0) + p.qty);
  }
  let saving = 0;
  const discounted = parts.map((p) => {
    const offer = !p.bundle && offers.get(p.productId);
    if (!offer || units.get(p.productId) < offer.minQty) return p;
    const off = unitSaving(p.price, offer.percent);
    if (!off) return p;
    saving += off * p.qty;
    return {
      ...p,
      price: p.price - off,
      regularPrice: p.price,
      quantityDiscount: { minQty: offer.minQty, percent: offer.percent },
    };
  });
  return { parts: discounted, saving };
}
