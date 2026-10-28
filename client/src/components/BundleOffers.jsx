import { useState } from 'react';
import { Link } from 'react-router';
import { addToCart } from '../cart.js';
import { formatPrice, smallImage } from '../format.js';
import { useFetch } from '../useFetch.js';

// "Buy together and save" on a product page (stage 83): the bundles it's in. "Add bundle" puts one of each in the
// cart; the saving is worked out there (the cart applies it to any full set, however it was added).
export default function BundleOffers({ slug }) {
  const { data } = useFetch(`/products/${slug}/bundles`);
  const [added, setAdded] = useState(null);
  if (!data?.items.length) return null;
  return (
    <section className="bundle-offers" aria-labelledby="bundles-heading">
      <h2 id="bundles-heading">Buy together and save</h2>
      {data.items.map((b) => (
        <div key={b.id} className="bundle-offer">
          <p className="bundle-name">{b.name}</p>
          <ul className="bundle-items">
            {b.products.map((p) => (
              <li key={p.id}>
                {p.image && <img src={smallImage(p.image)} alt="" width="48" height="48" />}
                <Link to={`/p/${p.slug}`}>{p.title}</Link> <span className="muted small">{formatPrice(p.price)}</span>
              </li>
            ))}
          </ul>
          <p>
            <strong>{formatPrice(b.price)}</strong> for all {b.products.length}{' '}
            <span className="muted">
              (<s>{formatPrice(b.regular)}</s>)
            </span>{' '}
            <span className="bundle-saving">save {formatPrice(b.saving)}</span>
          </p>
          {added === b.id ? (
            <p role="status">
              Added. <Link to="/cart">Go to cart</Link>
            </p>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={!b.inStock}
              onClick={() => {
                for (const p of b.products) addToCart(p.id, p.stock);
                setAdded(b.id);
              }}
            >
              {b.inStock ? (
                <>
                  Add bundle<span className="sr-only">: {b.name}</span>
                </>
              ) : (
                'One of these is out of stock'
              )}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
