// Product variants: one kind of option per product (its `variantName`, e.g. "Size"), each variant with its own label,
// price, MRP and stock. The product keeps price, mrp and stock as totals so listings, filters, sorting and stock checks
// work unchanged: the cheapest variant's price and MRP, and the sum of the stock. Every write that changes a variant's
// stock changes the product's `stock` by the same amount, in the same update.

// The product-level price, mrp and stock for a list of variants.
export function variantTotals(variants) {
  const cheapest = variants.reduce((min, v) => (v.price < min.price ? v : min));
  return { price: cheapest.price, mrp: cheapest.mrp, stock: variants.reduce((sum, v) => sum + v.stock, 0) };
}

// How an order line names a variant: "Stride Running Shoes (Size: UK 8)".
export const variantTitle = (product, variant) =>
  variant ? `${product.title} (${product.variantName}: ${variant.label})` : product.title;

export const findVariant = (product, variantId) =>
  product.variants?.find((v) => v._id.toString() === variantId?.toString()) ?? null;

export const toVariant = (v) => ({ id: v._id.toString(), label: v.label, price: v.price, mrp: v.mrp, stock: v.stock });
