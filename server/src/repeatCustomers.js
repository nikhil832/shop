// Repeat customers (stage 126), for the dashboard: of the customers who bought in the period, how many were new (their
// first sold order is in it) and how many came back (they had bought before), what each group spent, the usual time
// between a customer's orders, and, over all time, how many customers have bought more than once. Nothing is stored;
// every customer's sold orders are read once (fine at this size, like the customers page).
const DAY = 86_400_000;

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// `sold` is the dashboard's list of statuses that count as sales (passed in, as dashboard.js imports this module).
export async function repeatCustomers(db, from, now, sold) {
  const people = await db
    .collection('orders')
    .aggregate([
      { $match: { status: { $in: sold }, createdAt: { $lt: now } } },
      { $sort: { createdAt: 1 } },
      { $group: { _id: '$userId', orders: { $push: { at: '$createdAt', total: '$total' } } } },
    ])
    .toArray();

  const period = { customers: 0, new: 0, returning: 0, newRevenue: 0, returningRevenue: 0 };
  const gaps = [];
  let repeat = 0;
  for (const { orders } of people) {
    if (orders.length > 1) repeat += 1;
    const inPeriod = orders.filter((o) => o.at >= from);
    if (!inPeriod.length) continue;
    const spent = inPeriod.reduce((sum, o) => sum + o.total, 0);
    const isNew = orders[0].at >= from;
    period.customers += 1;
    period[isNew ? 'new' : 'returning'] += 1;
    period[isNew ? 'newRevenue' : 'returningRevenue'] += spent;
    // Days since the customer's previous order, for each order in the period that had one.
    orders.forEach((o, i) => {
      if (i > 0 && o.at >= from) gaps.push((o.at - orders[i - 1].at) / DAY);
    });
  }
  const daysBetween = median(gaps);
  return {
    ...period,
    // Customers in the period who ordered more than once in it.
    orderedAgain: people.filter(({ orders }) => orders.filter((o) => o.at >= from).length > 1).length,
    daysBetween: daysBetween === null ? null : Math.round(daysBetween),
    allTime: { customers: people.length, repeat },
  };
}
