import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { MAX_QTY, addToCart, qtyInCart, useCart } from '../cart.js';
import PriceTag from '../components/PriceTag.jsx';
import Rating from '../components/Rating.jsx';
import Reviews from '../components/Reviews.jsx';
import Questions from '../components/Questions.jsx';
import StockAlertButton from '../components/StockAlertButton.jsx';
import WishlistButton from '../components/WishlistButton.jsx';
import CompareToggle from '../components/CompareToggle.jsx';
import DeliveryCheck from '../components/DeliveryCheck.jsx';
import BundleOffers from '../components/BundleOffers.jsx';
import SizeGuide from '../components/SizeGuide.jsx';
import Gallery from '../components/Gallery.jsx';
import ProductRow from '../components/ProductRow.jsx';
import RecentlyViewed from '../components/RecentlyViewed.jsx';
import { rememberViewed } from '../recent.js';
import { reportSeen } from '../productStats.js';
import { expectedText, quantityOfferText, saleEndsIn } from '../format.js';
import { useFetch } from '../useFetch.js';
import NotFound from './NotFound.jsx';

// `variant` is the chosen size/colour of a product that has them (null until chosen); its own stock limits the quantity.
// `missing` names the options still to choose ("size", or "colour and size").
function AddToCart({ product, variant, missing }) {
  const items = useCart();
  const navigate = useNavigate();
  const [full, setFull] = useState(false);
  // Pressed before choosing: say what's missing (the button stays enabled, as a faded one looks broken).
  const [prompted, setPrompted] = useState(false);
  const needsChoice = product.variants.length > 0 && !variant;
  const stock = variant ? variant.stock : product.stock;
  const inCart = qtyInCart(items, product.id, variant?.id);
  const atLimit = !needsChoice && inCart >= Math.min(MAX_QTY, stock);

  function add() {
    if (needsChoice) {
      setPrompted(true);
      document.querySelector('.variant-picker button:not(:disabled)')?.focus();
      return false;
    }
    reportSeen(product.slug, 'cart');
    const added = addToCart(product.id, stock, variant?.id);
    setFull(!added);
    return added;
  }
  // Straight to checkout with this item (one more only if it isn't in the cart yet).
  function buyNow() {
    if (inCart > 0 || add()) navigate('/checkout');
  }

  // The buy bar (stage 102): on phones (CSS shows it only there), the price and these buttons stay at the bottom of
  // the screen while the buttons above are out of view. Measured in the observer's callback, not in the effect.
  const buttons = useRef(null);
  const [outOfView, setOutOfView] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setOutOfView(!entry.isIntersecting));
    observer.observe(buttons.current);
    return () => observer.disconnect();
  }, []);
  const bar = outOfView && stock > 0;
  // Lifts the assistant's button and the compare tray above the bar, and makes room for it under the footer.
  useEffect(() => {
    document.body.classList.toggle('buy-bar-shown', bar);
    return () => document.body.classList.remove('buy-bar-shown');
  }, [bar]);
  const priced = variant ?? product;

  return (
    <div className="buy-buttons" ref={buttons}>
      <button type="button" className="btn primary" disabled={atLimit || stock === 0} onClick={add}>
        {stock === 0 ? 'Out of stock' : atLimit ? 'Maximum quantity in cart' : 'Add to cart'}
      </button>
      {stock > 0 && !needsChoice && (
        <button type="button" className="btn buy-now" onClick={buyNow}>
          Buy now
        </button>
      )}
      {inCart > 0 && (
        <Link to="/cart" className="btn">
          Go to cart ({inCart} added)
        </Link>
      )}
      {prompted && needsChoice && (
        <p className="choose-prompt" role="alert">
          Choose a {missing} first
        </p>
      )}
      {full && <p className="error small">Your cart is full. Remove something to add this.</p>}
      {bar && (
        <div className="buy-bar" role="region" aria-label="Buy">
          <PriceTag price={priced.price} mrp={priced.mrp} from={!variant && product.priceFrom} />
          <div className="buy-bar-buttons">
            {needsChoice ? (
              // Focusing the first option scrolls the page up to the choices.
              <button type="button" className="btn primary" onClick={add}>
                Choose a {missing}
              </button>
            ) : (
              <>
                <button type="button" className="btn primary" disabled={atLimit} onClick={add}>
                  {atLimit ? 'In cart' : 'Add to cart'}
                </button>
                <button type="button" className="btn buy-now" onClick={buyNow}>
                  Buy now
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// One row of buttons per option (one or two, e.g. Colour and Size), with `chosen` holding the value picked in each.
// Each row depends on the rows before it: a size with no variant in the chosen colour can't be picked. A value whose
// variants are all sold out is crossed out but can be chosen, to ask for an email when it's back.
function VariantPicker({ product, chosen, onChoose }) {
  return product.options.map((name, i) => {
    const values = [...new Set(product.variants.map((v) => v.values[i]))];
    return (
      <fieldset key={name} className="variant-picker">
        <legend>
          {name}
          {chosen[i] !== undefined && <span className="muted">: {chosen[i]}</span>}
        </legend>
        <div className="variant-options">
          {values.map((value) => {
            const matching = product.variants.filter(
              (v) => v.values[i] === value && chosen.every((c, j) => j >= i || c === undefined || v.values[j] === c),
            );
            const soldOut = matching.length > 0 && matching.every((v) => v.stock === 0);
            return (
              <button
                key={value}
                type="button"
                className={[chosen[i] === value && 'selected', soldOut && 'sold-out'].filter(Boolean).join(' ')}
                aria-pressed={chosen[i] === value}
                disabled={matching.length === 0}
                onClick={() => onChoose(i, value)}
              >
                {value}
                {soldOut && <span className="sr-only"> (sold out)</span>}
                {matching.length === 0 && <span className="sr-only"> (not available)</span>}
              </button>
            );
          })}
        </div>
      </fieldset>
    );
  });
}

// A row of products under the product (loaded by the page); nothing while loading or when there's nothing to show.
function Row({ title, rows }) {
  if (rows.loading || !rows.data?.items.length) return null;
  return <ProductRow title={title} items={rows.data.items} />;
}

const stockText = (stock) => (stock === 0 ? 'Out of stock' : stock <= 5 ? `Only ${stock} left` : 'In stock');
const stockClass = (stock) => (stock === 0 ? 'out' : stock <= 5 ? 'low' : 'in');

export default function Product() {
  const { slug } = useParams();
  // Bumped after a review changes the rating; the page keeps showing the product while it reloads.
  const [version, setVersion] = useState(0);
  const { data: product, error, loading } = useFetch(`/products/${encodeURIComponent(slug)}`, version);
  // The value chosen for each option, for this product; kept while it reloads (e.g. after a review).
  const [choice, setChoice] = useState({ productId: null, values: [] });
  // The rows between the product and its reviews: what other customers bought in the same orders (at least two of
  // them, so no one's basket shows), and up to 8 products like this one. Loaded here so that a link to #reviews or
  // #questions (from emails) scrolls only once they're in and can't push the section out of view.
  const together = useFetch(`/products/${encodeURIComponent(slug)}/bought-together`);
  const similar = useFetch(`/products/${encodeURIComponent(slug)}/related`);
  const rowsIn = !together.loading && !similar.loading;
  // Remembered in this browser and reported as a view (stage 100) once the product has loaded (not for missing or
  // hidden ones).
  const viewed = product?.slug === slug ? slug : null;
  useEffect(() => {
    if (!viewed) return;
    rememberViewed(viewed);
    reportSeen(viewed, 'view');
  }, [viewed]);

  if (error?.status === 404) return <NotFound message="This product doesn't exist or is no longer sold." />;
  if (error) return <p className="error">{error.message}</p>;
  if (!product || (loading && product.slug !== slug)) return <p className="muted">Loading…</p>;

  const chosen = choice.productId === product.id ? choice.values : [];
  // Choosing a value keeps later choices only while a variant still has them all (Blue 34 → Black clears the 34).
  const choose = (i, value) => {
    const values = [...chosen];
    values[i] = value;
    const exists = (vals) => product.variants.some((v) => vals.every((c, j) => c === undefined || v.values[j] === c));
    for (let j = i + 1; j < values.length; j++) {
      if (!exists(values)) values[j] = undefined;
    }
    setChoice({ productId: product.id, values });
  };
  // The variant once every option is chosen.
  const variant = product.variants.find((v) => product.options.every((_, i) => v.values[i] === chosen[i])) ?? null;
  const missing = product.options
    .filter((_, i) => chosen[i] === undefined)
    .map((n) => n.toLowerCase())
    .join(' and ');
  // Shown for the chosen variant, or the whole product.
  const shown = variant ?? product;
  // Photos: the chosen variant's, or (with only a colour chosen) those of the first variant that matches so far.
  const photoSource = chosen.some((c) => c !== undefined)
    ? ((variant?.images.length ? variant : null) ??
      product.variants.find((v) => v.images.length && chosen.every((c, i) => c === undefined || v.values[i] === c)))
    : null;
  const choiceText = chosen.filter((c) => c !== undefined).join(', ');

  return (
    <>
      {/* The browser tab's title (React puts it in <head>); link previews get theirs from the server. */}
      <title>{`${product.title} · Bazaar`}</title>
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
        {/* Remount per product and variant so the gallery starts at the first image. A chosen variant with its own
            photos shows only those. */}
        <Gallery
          key={`${product.id}:${photoSource?.id ?? ''}`}
          images={photoSource?.images ?? product.images}
          title={choiceText ? `${product.title}, ${choiceText}` : product.title}
          alts={product.imageAlts}
        />
        <div className="product-info">
          <span className="brand">{product.brand}</span>
          <h1>{product.title}</h1>
          <Rating rating={product.rating} />
          <PriceTag price={shown.price} mrp={shown.mrp} large from={!variant && product.priceFrom} />
          {product.sale && (
            <p className="sale-note">
              <strong>{product.sale.name}</strong> · {saleEndsIn(product.sale.endsAt)}
            </p>
          )}
          <span className="muted small">Inclusive of all taxes</span>
          {product.quantityDiscount && <p className="quantity-note">{quantityOfferText(product.quantityDiscount)}</p>}
          {product.variants.length > 0 && product.stock > 0 && (
            <>
              <VariantPicker product={product} chosen={chosen} onChoose={choose} />
              <SizeGuide key={product.slug} slug={product.slug} />
            </>
          )}
          {product.comingSoon ? (
            <p className="stock soon">
              Coming soon{expectedText(product.comingSoon) && ` · ${expectedText(product.comingSoon)}`}
            </p>
          ) : (
            <p className={`stock ${stockClass(shown.stock)}`}>{stockText(shown.stock)}</p>
          )}
          {/* Sold out (the whole product, or the chosen variant): ask for an email instead. Remounted when the
              saved alerts change, so its state follows the reloaded product. */}
          {product.stock === 0 || variant?.stock === 0 ? (
            <StockAlertButton
              key={`alert-${product.id}:${variant?.id ?? ''}:${product.stockAlert}:${product.stockAlertVariants.join()}`}
              product={product}
              variant={variant}
              arriving={Boolean(product.comingSoon)}
              onChange={() => setVersion((v) => v + 1)}
            />
          ) : (
            <AddToCart key={product.id} product={product} variant={variant} missing={missing} />
          )}
          <div className="product-extras">
            <WishlistButton key={`wish-${product.id}`} product={product} />
            <CompareToggle product={product} />
          </div>
          <DeliveryCheck />
          <BundleOffers key={product.slug} slug={product.slug} />

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
      {/* Hidden while loading, so a row doesn't show the previous product's while the next loads. */}
      <Row title="Frequently bought together" rows={together} />
      <Row title="Similar products" rows={similar} />
      <Reviews key={product.id} product={product} canScroll={rowsIn} onChange={() => setVersion((v) => v + 1)} />
      <Questions key={`questions-${product.id}`} product={product} canScroll={rowsIn} />
      <RecentlyViewed exclude={product.slug} />
    </>
  );
}
