import { Link, useSearchParams } from 'react-router';
import { addToCart, qtyInCart, useCart } from '../cart.js';
import { removeFromCompare } from '../compare.js';
import { smallImage } from '../format.js';
import { useFetch } from '../useFetch.js';
import PriceTag from '../components/PriceTag.jsx';
import Rating from '../components/Rating.jsx';

const stockText = (stock) => (stock === 0 ? 'Out of stock' : stock <= 5 ? `Only ${stock} left` : 'In stock');

function Buy({ product: p }) {
  const items = useCart();
  if (p.variants.length) {
    return (
      <Link to={`/p/${p.slug}`} className="btn small">
        Choose a {p.variantName.toLowerCase()}
        <span className="sr-only"> of {p.title}</span>
      </Link>
    );
  }
  const inCart = qtyInCart(items, p.id);
  if (inCart) {
    return (
      <Link to="/cart" className="btn small">
        In your cart ({inCart})<span className="sr-only">: {p.title}</span>
      </Link>
    );
  }
  return (
    <button
      type="button"
      className="btn primary small"
      disabled={p.stock === 0}
      onClick={() => addToCart(p.id, p.stock)}
    >
      {p.stock === 0 ? 'Out of stock' : 'Add to cart'}
      <span className="sr-only"> {p.title}</span>
    </button>
  );
}

// /compare?slugs=a,b,c (stage 73): up to three products side by side, with live prices and stock. The address names
// them, so a comparison can be shared; removing one here takes it out of this browser's list too.
export default function Compare() {
  const [params, setParams] = useSearchParams();
  const slugs = (params.get('slugs') ?? '').split(',').filter(Boolean);
  const { data, error, loading } = useFetch(slugs.length ? `/compare?slugs=${slugs.join(',')}` : null);

  function remove(slug) {
    removeFromCompare(slug);
    const rest = slugs.filter((s) => s !== slug);
    setParams(rest.length ? { slugs: rest.join(',') } : {});
  }

  if (!slugs.length || data?.items.length === 0) {
    return (
      <div className="empty-state">
        <h1>Nothing to compare</h1>
        <p>Tick &ldquo;Compare&rdquo; under up to three products from one category, then compare them here.</p>
        <Link to="/" className="btn primary">
          Browse the store
        </Link>
      </div>
    );
  }
  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const products = data.items;
  const category = products[0].category;
  const rows = [
    ['Price', (p) => <PriceTag price={p.price} mrp={p.mrp} from={p.priceFrom} />],
    ['Rating', (p) => (p.rating?.count ? <Rating rating={p.rating} /> : <span className="muted">No ratings yet</span>)],
    ['Brand', (p) => p.brand],
    [
      'Highlights',
      (p) =>
        p.highlights.length ? (
          <ul className="compare-list">
            {p.highlights.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        ) : (
          <span className="muted">—</span>
        ),
    ],
    [
      'Options',
      (p) =>
        p.variants.length ? (
          <>
            <span className="muted small">{p.options.join(' × ')}</span>
            <ul className="compare-list">
              {p.variants.map((v) => (
                <li key={v.id} className={v.stock === 0 ? 'muted' : ''}>
                  {v.label}
                  {v.stock === 0 && ' (sold out)'}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <span className="muted">One option</span>
        ),
    ],
    ['Stock', (p) => stockText(p.stock)],
    ['', (p) => <Buy product={p} />],
  ];

  return (
    <div className={`panel compare-page ${loading ? 'stale' : ''}`}>
      <title>Compare products · Bazaar</title>
      <h1>Compare{data.sameCategory && category ? ` ${category.name.toLowerCase()}` : ' products'}</h1>
      {!data.sameCategory && <p className="notice">These are from different categories.</p>}
      {products.length < slugs.length && (
        <p className="muted small">
          {slugs.length - products.length === 1 ? 'One product is' : 'Some products are'} no longer sold and left out.
        </p>
      )}
      <div className="table-wrap">
        <table className="compare-table">
          <thead>
            <tr>
              <td />
              {products.map((p) => (
                <th key={p.id} scope="col">
                  <Link to={`/p/${p.slug}`} className="compare-product">
                    {p.image && <img src={smallImage(p.image)} alt="" width="120" height="120" />}
                    <span>{p.title}</span>
                  </Link>
                  <button type="button" className="link small" onClick={() => remove(p.slug)}>
                    Remove<span className="sr-only"> {p.title}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, cell], i) => (
              <tr key={i}>
                {label ? <th scope="row">{label}</th> : <td />}
                {products.map((p) => (
                  <td key={p.id}>{cell(p)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {products.length < 3 && category && (
        <p className="small">
          <Link to={`/search?category=${category.slug}`}>Add another from {category.name}</Link>
        </p>
      )}
    </div>
  );
}
