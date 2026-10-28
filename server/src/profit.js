// Profit (stage 80): from the cost price each order item was sold with (`items[].cost`, snapshotted at the sale, so a
// later change of cost doesn't rewrite the past). For sold orders (placed, shipped, delivered) created in a period:
// an item's sales are its price × qty less its share of a coupon's discount (as returns work it out; a free-delivery
// coupon is the delivery's, not the items'), and its cost is cost × qty. Items of approved returns come off both, as
// they came back. Delivery charges and items with no cost price are left out (`uncostedItems` says how many), so the
// margin is over items with a cost. Nothing is stored.

// The same lists as routes/dashboard.js, which imports this module (importing them back would make a cycle).
const SOLD = ['placed', 'shipped', 'delivered'];
const REFUNDED_RETURNS = ['approved', 'refunding', 'refunded', 'refund_failed'];

const discountShare = (order, value) => {
  const discount = order.coupon?.type === 'free_delivery' ? 0 : (order.discount ?? 0);
  return order.subtotal ? Math.round((discount * value) / order.subtotal) : 0;
};

// { sales, cost, profit, margin (percent, one decimal, or null), items, uncostedItems, byProduct: Map(id → profit) }
// for orders created from `from` until `to`.
export async function profitFor(db, from, to) {
  const orders = await db
    .collection('orders')
    .find(
      { status: { $in: SOLD }, createdAt: { $gte: from, $lt: to } },
      { projection: { items: 1, subtotal: 1, discount: 1, coupon: 1 } },
    )
    .toArray();
  const returns = orders.length
    ? await db
        .collection('returns')
        .find(
          { orderId: { $in: orders.map((o) => o._id) }, status: { $in: REFUNDED_RETURNS } },
          { projection: { orderId: 1, items: 1 } },
        )
        .toArray()
    : [];
  const returned = new Map(); // order id → { line index: qty back }
  for (const r of returns) {
    const lines = returned.get(r.orderId.toString()) ?? {};
    for (const i of r.items) lines[i.index] = (lines[i.index] ?? 0) + i.qty;
    returned.set(r.orderId.toString(), lines);
  }

  let sales = 0;
  let cost = 0;
  let items = 0;
  let uncostedItems = 0;
  const byProduct = new Map();
  for (const order of orders) {
    const back = returned.get(order._id.toString()) ?? {};
    order.items.forEach((line, index) => {
      const qty = line.qty - (back[index] ?? 0);
      if (qty <= 0) return;
      items += qty;
      if (line.cost === undefined || line.cost === null) {
        uncostedItems += qty;
        return;
      }
      const value = line.price * qty;
      const lineSales = value - discountShare(order, value);
      const lineCost = line.cost * qty;
      sales += lineSales;
      cost += lineCost;
      const id = line.productId.toString();
      byProduct.set(id, (byProduct.get(id) ?? 0) + lineSales - lineCost);
    });
  }
  const profit = sales - cost;
  return {
    sales,
    cost,
    profit,
    margin: sales ? Math.round((profit / sales) * 1000) / 10 : null,
    items,
    uncostedItems,
    byProduct,
  };
}
