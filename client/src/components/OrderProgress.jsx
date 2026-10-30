import { arrival, formatDate } from '../format.js';

// Where an order is on its way, as three steps: ordered, shipped, delivered, each with its date once reached (the
// promised arrival under "Delivered" until then). Only for orders on their way or delivered; cancelled and unpaid
// orders say so in words above it instead.
export default function OrderProgress({ order }) {
  if (!['placed', 'shipped', 'delivered'].includes(order.status)) return null;
  const steps = [
    { name: 'Ordered', at: order.createdAt },
    { name: 'Shipped', at: order.shippedAt },
    {
      name: 'Delivered',
      at: order.deliveredAt,
      expected: order.deliveryEstimate && `Arriving ${arrival(order.deliveryEstimate)}`,
    },
  ];
  const reached = steps.filter((s) => s.at).length - 1;
  return (
    <ol className="order-progress" aria-label="Order progress">
      {steps.map((s, i) => (
        <li key={s.name} className={i <= reached ? 'done' : 'todo'} aria-current={i === reached ? 'step' : undefined}>
          <span className="step-dot" aria-hidden="true" />
          <span className="step-name">{s.name}</span>
          <span className="muted small">
            {s.at ? formatDate(s.at) : (s.expected ?? 'Not yet')}
            <span className="sr-only">{i <= reached ? ' (done)' : ' (to come)'}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
