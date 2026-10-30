import { useParams } from 'react-router';
import { GiftIcon } from '../components/Icons.jsx';
import ProductCard from '../components/ProductCard.jsx';
import { useFetch } from '../useFetch.js';
import NotFound from './NotFound.jsx';

// /w/:token (stage 106): a wishlist its owner shared by a link, for family and friends buying them a present. Only
// their first name and the products are shown; "Add" puts one in the visitor's own cart.
export default function SharedWishlist() {
  const { token } = useParams();
  const { data, error } = useFetch(`/shared-wishlists/${encodeURIComponent(token)}`);
  if (error?.status === 404) return <NotFound message={error.message} />;
  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div className="shared-wishlist">
      <title>{`${data.name}'s wishlist · Bazaar`}</title>
      <section className="shared-wishlist-head">
        <span className="promise-icon">
          <GiftIcon />
        </span>
        <div>
          <h1>{data.name}&apos;s wishlist</h1>
          <p className="muted">
            Buying a present? Add it to your cart, then tick &ldquo;This is a gift&rdquo; at checkout to send it with a
            message. No prices go in the parcel.
          </p>
        </div>
      </section>
      {data.items.length === 0 ? (
        <p className="muted">Nothing on {data.name}&apos;s wishlist right now.</p>
      ) : (
        <div className="product-grid">
          {data.items.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      )}
    </div>
  );
}
