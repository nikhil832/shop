import { MAX_COMPARE, toggleCompare, useCompare } from '../compare.js';

// "Compare" under a product card or on the product page. Full (three from this category) and not chosen: disabled.
export default function CompareToggle({ product }) {
  const { items } = useCompare();
  const chosen = items.some((p) => p.slug === product.slug);
  const full = !chosen && items.length >= MAX_COMPARE && items[0].categoryId === product.categoryId;
  return (
    <label className={`compare-toggle ${full ? 'disabled' : ''}`}>
      <input type="checkbox" checked={chosen} disabled={full} onChange={() => toggleCompare(product)} />
      Compare<span className="sr-only"> {product.title}</span>
      {full && <span className="muted small"> (3 chosen)</span>}
    </label>
  );
}
