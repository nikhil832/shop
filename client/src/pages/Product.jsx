import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { MAX_QTY, addToCart, useCart } from '../cart.js';
import PriceTag from '../components/PriceTag.jsx';
import Rating from '../components/Rating.jsx';
import Reviews from '../components/Reviews.jsx';
import StockAlertButton from '../components/StockAlertButton.jsx';
import WishlistButton from '../components/WishlistButton.jsx';
import { useFetch } from '../useFetch.js';
import NotFound from './NotFound.jsx';

function Gallery({ images, title }) {
  const [selected, setSelected] = useState(0);
  return (
    <div className="gallery">
      <div className="gallery-main">
        <img src={images[selected]} alt={title} width="600" height="600" />
      </div>
      {images.length > 1 && (
        <div className="thumbs">
          {images.map((src, i) => (
            <button
              key={src}
              type="button"
              className={i === selected ? 'selected' : ''}
              onClick={() => setSelected(i)}
              aria-label={`Show image ${i + 1}`}
              aria-pressed={i === selected}
            >
              <img src={src} alt="" width="64" height="64" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AddToCart({ product }) {
  const items = useCart();
  const [full, setFull] = useState(false);
  const inCart = items.find((i) => i.productId === product.id)?.qty ?? 0;
  const atLimit = inCart >= Math.min(MAX_QTY, product.stock);
  return (
    <div className="buy-buttons">
      <button
        type="button"
        className="btn primary"
        disabled={atLimit}
        onClick={() => setFull(!addToCart(product.id, product.stock))}
      >
        {atLimit ? 'Maximum quantity in cart' : 'Add to cart'}
      </button>
      {inCart > 0 && (
        <Link to="/cart" className="btn">
          Go to cart ({inCart} added)
        </Link>
      )}
      {full && <p className="error small">Your cart is full. Remove something to add this.</p>}
    </div>
  );
}

export default function Product() {
  const { slug } = useParams();
  // Bumped after a review changes the rating; the page keeps showing the product while it reloads.
  const [version, setVersion] = useState(0);
  const { data: product, error, loading } = useFetch(`/products/${encodeURIComponent(slug)}`, version);

  if (error?.status === 404) return <NotFound message="This product doesn't exist or is no longer sold." />;
  if (error) return <p className="error">{error.message}</p>;
  if (!product || (loading && product.slug !== slug)) return <p className="muted">Loading…</p>;

  const stockText =
    product.stock === 0 ? 'Out of stock' : product.stock <= 5 ? `Only ${product.stock} left` : 'In stock';

  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/">Home</Link>
        {product.category && (
          <>
            <span aria-hidden>›</span>
            <Link to={`/search?category=${product.category.slug}`}>{product.category.name}</Link>
          </>
        )}
      </nav>

      <article className="product">
        {/* Remount per product so the gallery starts at the first image. */}
        <Gallery key={product.id} images={product.images} title={product.title} />
        <div className="product-info">
          <span className="brand">{product.brand}</span>
          <h1>{product.title}</h1>
          <Rating rating={product.rating} />
          <PriceTag price={product.price} mrp={product.mrp} large />
          <span className="muted small">Inclusive of all taxes</span>
          <p className={`stock ${product.stock === 0 ? 'out' : product.stock <= 5 ? 'low' : 'in'}`}>{stockText}</p>
          {product.stock === 0 ? (
            <StockAlertButton key={`alert-${product.id}`} product={product} />
          ) : (
            <AddToCart key={product.id} product={product} />
          )}
          <WishlistButton key={`wish-${product.id}`} product={product} />

          {product.highlights.length > 0 && (
            <section>
              <h2>Highlights</h2>
              <ul className="highlights">
                {product.highlights.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h2>Description</h2>
            <p>{product.description}</p>
          </section>
        </div>
      </article>
      <Reviews key={product.id} product={product} onChange={() => setVersion((v) => v + 1)} />
    </>
  );
}
