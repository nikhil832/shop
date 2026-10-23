// Product variants: one kind of option per product (its `variantName`, e.g. "Size"), each variant with its own label,
// price, MRP and stock, and optionally some of the product's photos (`images`, always a subset of the product's, so the
// unused-upload sweep and image checks only need the product's list). The product keeps price, mrp and stock as totals
// so listings, filters, sorting and stock checks work unchanged: the cheapest variant's price and MRP, and the sum of
// the stock. Every write that changes a variant's stock changes the product's `stock` by the same amount, in the same
// update.

// The product-level price, mrp and stock for a list of variants.
export function variantTotals(variants) {
  const cheapest = variants.reduce((min, v) => (v.price < min.price ? v : min));
  return { price: cheapest.price, mrp: cheapest.mrp, stock: variants.reduce((sum, v) => sum + v.stock, 0) };
}

// Up to two kinds of option per product (stage 24), e.g. Colour and Size. `options` holds their names and each
// variant's `values` its value for each, in order; `variantName` is the phrase for both ("Colour and size") and `label`
// the values joined ("Black / 32"). Products from before have just `variantName` and `label`, read as one option.
export const MAX_OPTIONS = 2;
export const optionsOf = (product) =>
  product.options?.length ? product.options : product.variantName ? [product.variantName] : [];
export const valuesOf = (variant) => (variant.values?.length ? variant.values : [variant.label]);
// "Size", or "Colour and size" for two.
export const optionsPhrase = (names) => names.map((n, i) => (i ? n.toLowerCase() : n)).join(' and ');
export const variantLabel = (values) => values.join(' / ');

// "Size: UK 8", or "Colour: Black, Size: 32".
export const variantDescription = (product, variant) => {
  const values = valuesOf(variant);
  return optionsOf(product)
    .map((name, i) => `${name}: ${values[i]}`)
    .join(', ');
};

// How an order line names a variant: "Stride Running Shoes (Size: UK 8)".
export const variantTitle = (product, variant) =>
  variant ? `${product.title} (${variantDescription(product, variant)})` : product.title;

export const findVariant = (product, variantId) =>
  product.variants?.find((v) => v._id.toString() === variantId?.toString()) ?? null;

export const toVariant = (v) => ({
  id: v._id.toString(),
  label: v.label,
  values: valuesOf(v),
  price: v.price,
  mrp: v.mrp,
  stock: v.stock,
  images: v.images ?? [],
});

// The photo shown for a product, or for one of its variants (its first own photo, else the product's).
export const imageFor = (product, variant) => variant?.images?.[0] ?? product.images[0] ?? null;
