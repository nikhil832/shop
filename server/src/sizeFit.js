import { z } from 'zod';
import { SIZE_OPTION } from './sizes.js';
import { optionsOf } from './variants.js';

// Size fit from reviews (stage 137): reviewers of a product with a size (an option called Size or Waist) may say how
// it fits; `reviews.fit` is one of FITS or null. The product page shows what most visible reviews say, once at least
// MIN_FIT_ANSWERS have answered. Imports nothing of the store's routes, so catalog.js and reviews.js can both use it.
export const FITS = ['small', 'true', 'large'];
export const MIN_FIT_ANSWERS = 3;

export const fitField = z.enum(FITS, { message: 'fit: Choose runs small, true to size or runs large' }).nullable();

export const hasSizes = (product) =>
  Boolean(product.variants?.length) && optionsOf(product).some((n) => SIZE_OPTION.test(n));

// { small, true, large, total, verdict } over the product's visible reviews with a fit, `verdict` the answer at least
// half of them gave (else null: reviewers are split); null when the product has no sizes or too few answered.
export async function sizeFit(db, product) {
  if (!hasSizes(product)) return null;
  const counts = await db
    .collection('reviews')
    .aggregate([
      { $match: { productId: product._id, hidden: false, fit: { $in: FITS } } },
      { $group: { _id: '$fit', count: { $sum: 1 } } },
    ])
    .toArray();
  const fit = Object.fromEntries(FITS.map((f) => [f, counts.find((c) => c._id === f)?.count ?? 0]));
  const total = FITS.reduce((sum, f) => sum + fit[f], 0);
  if (total < MIN_FIT_ANSWERS) return null;
  const top = FITS.reduce((a, b) => (fit[b] > fit[a] ? b : a));
  return { ...fit, total, verdict: fit[top] * 2 >= total ? top : null };
}
