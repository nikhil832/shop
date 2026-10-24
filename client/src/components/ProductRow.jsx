import { Link } from 'react-router';
import ProductCard from './ProductCard.jsx';

// A titled row of product cards that scrolls sideways, with an optional "View all" link or an action button.
export default function ProductRow({ title, items, error, moreLink, action }) {
  const id = `row-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section className="row-section" aria-labelledby={id}>
      <div className="row-header">
        <h2 id={id}>{title}</h2>
        {moreLink && <Link to={moreLink}>View all</Link>}
        {action}
      </div>
      {error && <p className="error">{error.message}</p>}
      <div className="product-row">
        {items?.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>
    </section>
  );
}
