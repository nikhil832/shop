// Reorder suggestions (stage 75): how long each product's (or option's) stock lasts at its recent sales, for the
// dashboard's "Running out soon" and the morning low-stock email. Nothing is stored; it's worked out from orders.
// Sales are units in sold orders (placed, shipped, delivered; returns aren't taken off) over the last WINDOW_DAYS, or
// since the product was added if that's later (at least MIN_DAYS, so a product added yesterday isn't judged on a day).

export const WINDOW_DAYS = 30;
export const MIN_DAYS = 7;
export const RUNOUT_DAYS = 14; // listed when the stock lasts this long or less
export const COVER_DAYS = 30; // the suggestion: enough to last this long
const DAY = 86_400_000;
// The same as SOLD in routes/dashboard.js, which imports this module (importing it back would make a cycle).
const SOLD = ['placed', 'shipped', 'delivered'];

// Days the stock lasts at `perDay`, rounded down; 0 when none is left. `perDay` > 0.
export const daysLeft = (stock, perDay) => Math.floor(stock / perDay);
// How many to order so the stock lasts COVER_DAYS (none when it already does).
export const suggestion = (stock, perDay) => Math.max(0, Math.ceil(perDay * COVER_DAYS) - stock);

// Units still to come from open supplier orders (stage 93, purchaseOrders.js), by "productId.variantId".
async function onOrder(db) {
  const rows = await db
    .collection('purchaseOrders')
    .aggregate([
      { $match: { status: 'open' } },
      { $unwind: '$lines' },
      {
        $group: {
          _id: { productId: '$lines.productId', variantId: '$lines.variantId' },
          units: { $sum: { $max: [0, { $subtract: ['$lines.qty', '$lines.received'] }] } },
        },
      },
    ])
    .toArray();
  return new Map(rows.map((r) => [`${r._id.productId}.${r._id.variantId ?? ''}`, r.units]));
}

// Products and options that sold in the window and run out within RUNOUT_DAYS, soonest first:
// [{ productId, variantId, slug, title, label, stock, sold, days (the window used), perDay, daysLeft, onOrder,
//   suggest, suggestCost }]. The suggestion leaves out what's already on order (but the row stays until it arrives).
// Only shown products, and options that still exist. `total` counts them all; `items` has the first `limit`.
export async function runningOut(db, now = new Date(), limit = 20) {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY);
  const sales = await db
    .collection('orders')
    .aggregate([
      { $match: { status: { $in: SOLD }, createdAt: { $gte: since } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: { productId: '$items.productId', variantId: { $ifNull: ['$items.variantId', null] } },
          sold: { $sum: '$items.qty' },
        },
      },
    ])
    .toArray();
  if (!sales.length) return { items: [], total: 0 };
  const ordered = await onOrder(db);
  const products = new Map(
    (
      await db
        .collection('products')
        .find(
          { _id: { $in: [...new Set(sales.map((s) => s._id.productId))] }, active: true },
          { projection: { slug: 1, title: 1, stock: 1, cost: 1, variants: 1, createdAt: 1 } },
        )
        .toArray()
    ).map((p) => [p._id.toString(), p]),
  );
  const rows = [];
  for (const { _id, sold } of sales) {
    const product = products.get(_id.productId.toString());
    if (!product) continue;
    const variant = _id.variantId && product.variants?.find((v) => v._id.equals(_id.variantId));
    if (_id.variantId && !variant) continue; // the option was removed since
    if (!_id.variantId && product.variants?.length) continue; // bought before it had options
    const stock = variant ? variant.stock : product.stock;
    const age = product.createdAt ? (now - product.createdAt) / DAY : WINDOW_DAYS;
    const days = Math.max(MIN_DAYS, Math.min(WINDOW_DAYS, Math.ceil(age)));
    const perDay = sold / days;
    const left = daysLeft(stock, perDay);
    if (left > RUNOUT_DAYS) continue;
    const coming = ordered.get(`${product._id}.${variant ? variant._id : ''}`) ?? 0;
    const suggest = Math.max(0, suggestion(stock, perDay) - coming);
    rows.push({
      productId: product._id.toString(),
      variantId: variant ? variant._id.toString() : null,
      slug: product.slug,
      title: product.title,
      label: variant ? variant.label : null,
      stock,
      sold,
      days,
      perDay: Math.round(perDay * 10) / 10,
      daysLeft: left,
      onOrder: coming,
      suggest,
      // What that order would cost at the cost price (stage 80), or null without one.
      suggestCost: (variant ?? product).cost != null ? suggest * (variant ?? product).cost : null,
    });
  }
  rows.sort((a, b) => a.daysLeft - b.daysLeft || b.perDay - a.perDay || a.title.localeCompare(b.title));
  return { items: rows.slice(0, limit), total: rows.length };
}
