// Size fit from reviews (stage 137): the answers' words, and whether a product has sizes (an option called Size or
// Waist, like SIZE_OPTION in server/src/sizes.js).
export const FIT_LABELS = { small: 'Runs small', true: 'True to size', large: 'Runs large' };
export const hasSizes = (product) => product.options?.some((n) => /^(size|waist)$/i.test(n)) ?? false;

// The product page's line: "Most say: true to size (8 of 12 reviews)", or the split when no answer has half.
export function fitText(fit) {
  if (fit.verdict) {
    return `Most say: ${FIT_LABELS[fit.verdict].toLowerCase()} (${fit[fit.verdict]} of ${fit.total} reviews)`;
  }
  const parts = ['small', 'true', 'large'].map((f) => `${fit[f]} ${FIT_LABELS[f].toLowerCase()}`);
  return `Reviewers are split on fit: ${parts.join(', ')}`;
}
