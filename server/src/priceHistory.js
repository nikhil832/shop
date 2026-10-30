// Price history (stage 112): each product's lowest price per India-time day, from now on, so its page can say
// "Lowest price in 30 days" honestly. Collection `priceDays` { productId, day ('YYYY-MM-DD'), low, expiresAt } (unique
// pair, TTL KEEP_DAYS). notePrices() records the current price of some products (a $min, so a day keeps its lowest):
// it runs after every price change (admin saves, the CSV import, sales starting and ending) and, once a day from the
// minute sweep, for every shown product, so each day has an entry. It never throws: a failure only loses a day's low.
export const KEEP_DAYS = 60;
export const WINDOW_DAYS = 30;
// Fewer days of history than this: nothing is claimed.
export const MIN_DAYS = 7;
const DAY = 86_400_000;
const IST_OFFSET = 330 * 60_000;
const istDay = (date) => new Date(date.getTime() + IST_OFFSET).toISOString().slice(0, 10);

export async function notePrices(db, filter, now = new Date()) {
  try {
    const docs = await db
      .collection('products')
      .find(filter, { projection: { price: 1 } })
      .toArray();
    if (!docs.length) return;
    const day = istDay(now);
    const expiresAt = new Date(now.getTime() + KEEP_DAYS * DAY);
    await db.collection('priceDays').bulkWrite(
      docs.map((p) => ({
        updateOne: {
          filter: { productId: p._id, day },
          update: { $min: { low: p.price }, $setOnInsert: { expiresAt } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  } catch (err) {
    console.error('Could not record prices:', err.message);
  }
}

// Once per India-time day (the first sweep of the day claims it, like the low-stock email): every shown product.
export async function recordDailyPrices(ctx, now = new Date()) {
  const day = istDay(now);
  try {
    await ctx.db
      .collection('settings')
      .updateOne({ _id: 'priceHistory', day: { $ne: day } }, { $set: { day } }, { upsert: true });
  } catch (err) {
    if (err.code === 11000) return 'done'; // already claimed today
    throw err;
  }
  await notePrices(ctx.db, { active: true }, now);
  return 'recorded';
}

// For the product page: over the last WINDOW_DAYS (today included) with at least MIN_DAYS of history, the lowest
// price and whether today's is it. Null with too little history.
export async function priceInsight(db, product, now = new Date()) {
  const since = istDay(new Date(now.getTime() - (WINDOW_DAYS - 1) * DAY));
  const [stats] = await db
    .collection('priceDays')
    .aggregate([
      { $match: { productId: product._id, day: { $gte: since } } },
      { $group: { _id: null, days: { $sum: 1 }, low: { $min: '$low' } } },
    ])
    .toArray();
  if (!stats || stats.days < MIN_DAYS) return null;
  const lowest = Math.min(stats.low, product.price);
  return { days: stats.days, lowest, isLowest: product.price <= lowest };
}
