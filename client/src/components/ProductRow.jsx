import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ChevronLeft, ChevronRight } from './Icons.jsx';
import ProductCard from './ProductCard.jsx';

// A titled row of product cards that scrolls sideways, with an optional "View all" link or an action button. With a
// mouse, arrow buttons at its ends scroll it by a screenful (they show only while there is more that way); on touch
// screens the row is swiped and the arrows are hidden by CSS.
export default function ProductRow({ title, items, error, moreLink, action }) {
  const id = `row-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const scroller = useRef(null);
  const [ends, setEnds] = useState({ start: true, end: true });

  // Which ends the row is at, measured when it scrolls or changes size (in those callbacks, not in the effect).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () =>
      setEnds({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', measure);
    };
  }, [items]);

  const scroll = (direction) =>
    scroller.current?.scrollBy({ left: direction * scroller.current.clientWidth * 0.9, behavior: 'smooth' });

  return (
    <section className="row-section" aria-labelledby={id}>
      <div className="row-header">
        <h2 id={id}>{title}</h2>
        {moreLink && <Link to={moreLink}>View all</Link>}
        {action}
      </div>
      {error && <p className="error">{error.message}</p>}
      <div className="product-row-wrap">
        {!ends.start && (
          <button
            type="button"
            className="row-arrow prev"
            onClick={() => scroll(-1)}
            aria-label={`Scroll ${title} back`}
          >
            <ChevronLeft />
          </button>
        )}
        <div className="product-row" ref={scroller}>
          {items?.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
        {!ends.end && (
          <button type="button" className="row-arrow next" onClick={() => scroll(1)} aria-label={`Scroll ${title} on`}>
            <ChevronRight />
          </button>
        )}
      </div>
    </section>
  );
}
