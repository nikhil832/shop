import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { MAX_QTY, addToCart, qtyInCart, useCart } from '../cart.js';
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

// `variant` is the chosen size/colour of a product that has them (null until chosen); its own stock limits the quantity.
function AddToCart({ product, variant }) {
  const items = useCart();
  const [full, setFull] = useState(false);
  const needsChoice = product.variants.length > 0 && !variant;
  const stock = variant ? variant.stock : product.stock;
  const inCart = qtyInCart(items, product.id, variant?.id);
  const atLimit = !needsChoice && inCart >= Math.min(MAX_QTY, stock);
  return (
    <div className="buy-buttons">
      <button
        type="button"
        className="btn primary"
        disabled={needsChoice || atLimit || stock === 0}
        onClick={() => setFull(!addToCart(product.id, stock, variant?.id))}
      >
        {needsChoice
          ? `Choose a ${product.variantName.toLowerCase()}`
          : stock === 0
            ? 'Out of stock'
            : atLimit
              ? 'Maximum quantity in cart'
              : 'Add to cart'}
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

// One button per variant; sold-out ones can't be chosen.
function VariantPicker({ product, selected, onSelect }) {
  return (
    <fieldset className="variant-picker">
      <legend>
        {product.variantName}
        {selected && <span className="muted">: {selected.label}</span>}
      </legend>
      <div className="variant-options">
        {product.variants.map((v) => (
          <button
            key={v.id}
            type="button"
            className={v.id === selected?.id ? 'selected' : ''}
            aria-pressed={v.id === selected?.id}
            disabled={v.stock === 0}
            onClick={() => onSelect(v.id)}
          >
            {v.label}
            {v.stock === 0 && <span className="sr-only"> (sold out)</span>}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

const stockText = (stock) => (stock === 0 ? 'Out of stock' : stock <= 5 ? `Only ${stock} left` : 'In stock');
const stockClass = (stock) => (stock === 0 ? 'out' : stock <= 5 ? 'low' : 'in');

export default function Product() {
  const { slug } = useParams();
  // Bumped after a review changes the rating; the page keeps showing the product while it reloads.
  const [version, setVersion] = useState(0);
  const { data: product, error, loading } = useFetch(`/products/${encodeURIComponent(slug)}`, version);
  // The chosen variant, by id; it stays chosen while the product reloads (e.g. after a review).
  const [variantId, setVariantId] = useState(null);

  if (error?.status === 404) return <NotFound message="This product doesn't exist or is no longer sold." />;
  if (error) return <p className="error">{error.message}</p>;
  if (!product || (loading && product.slug !== slug)) return <p className="muted">Loading…</p>;

  const variant = product.variants.find((v) => v.id === variantId) ?? null;
  // Shown for the chosen variant, or the whole product.
  const shown = variant ?? product;

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
          <PriceTag price={shown.price} mrp={shown.mrp} large from={!variant && product.priceFrom} />
          <span className="muted small">Inclusive of all taxes</span>
          {product.variants.length > 0 && product.stock > 0 && (
            <VariantPicker product={product} selected={variant} onSelect={setVariantId} />
          )}
          <p className={`stock ${stockClass(shown.stock)}`}>{stockText(shown.stock)}</p>
          {product.stock === 0 ? (
            <StockAlertButton key={`alert-${product.id}`} product={product} />
          ) : (
            <AddToCart key={product.id} product={product} variant={variant} />
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
