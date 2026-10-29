import { useRef, useState } from 'react';
import { smallImage } from '../format.js';

// How far a finger (or mouse) has to move sideways to count as a swipe, in pixels.
const SWIPE = 50;
const ZOOM = 2.5;

// Sideways swipes on an element: `go(1)` for the next photo (swiping left), `go(-1)` for the previous; nothing when
// `go` is null. `swiped()` tells a click handler that the click ended a swipe, so it can ignore it.
function useSwipe(go) {
  const start = useRef(null);
  const justSwiped = useRef(false);
  return {
    handlers: {
      onPointerDown: (e) => {
        start.current = { x: e.clientX, y: e.clientY };
        justSwiped.current = false;
      },
      onPointerUp: (e) => {
        const from = start.current;
        start.current = null;
        if (!from || !go) return;
        const dx = e.clientX - from.x;
        if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(e.clientY - from.y)) {
          justSwiped.current = true;
          go(dx < 0 ? 1 : -1);
        }
      },
      onPointerCancel: () => (start.current = null),
    },
    swiped: () => justSwiped.current,
  };
}

// Where on the photo the pointer is, as a CSS transform origin ("30% 62%"), so zooming in keeps that spot under it.
function originAt(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const x = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100));
  const y = Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100));
  return `${x}% ${y}%`;
}

// The product page's photos (stage 94 added the viewer): the chosen one large with thumbnails below; swiping it on a
// phone moves between them. "Enlarge" (or a tap on the photo) opens the browser's own <dialog> (focus stays inside,
// Escape closes) with the photo as large as the screen allows: previous/next buttons, arrow keys and swipes move
// between photos, and a tap (or "Zoom in") zooms in where it was tapped; moving across it then looks around.
export default function Gallery({ images, title, alts = {} }) {
  const [selected, setSelected] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const [origin, setOrigin] = useState('50% 50%');
  const dialog = useRef(null);
  const many = images.length > 1;
  const go = (by) => {
    setSelected((i) => (i + by + images.length) % images.length);
    setZoomed(false);
  };
  const altOf = (i) => alts[images[i]] || title;
  const page = useSwipe(many ? go : null);
  const viewer = useSwipe(many && !zoomed ? go : null);
  const open = () => dialog.current.showModal();
  const position = many ? ` ${selected + 1} of ${images.length}` : '';

  return (
    <div className="gallery">
      <div className="gallery-main" {...page.handlers}>
        {/* A tap on the photo opens the viewer too; keyboards and screen readers use the button. */}
        <img
          src={images[selected]}
          alt={altOf(selected)}
          width="600"
          height="600"
          onClick={() => !page.swiped() && open()}
        />
        <button type="button" className="btn small gallery-enlarge" onClick={open}>
          Enlarge<span className="sr-only"> photo{position}</span>
        </button>
      </div>
      {many && (
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
              <img src={smallImage(src)} alt="" width="64" height="64" />
            </button>
          ))}
        </div>
      )}
      <dialog
        ref={dialog}
        className="photo-viewer"
        aria-label={`Photos of ${title}`}
        onClose={() => setZoomed(false)}
        onKeyDown={(e) => {
          if (many && e.key === 'ArrowRight') go(1);
          if (many && e.key === 'ArrowLeft') go(-1);
        }}
      >
        <div className="photo-viewer-bar">
          {many && (
            <span aria-live="polite">
              Photo {selected + 1} of {images.length}
            </span>
          )}
          <button type="button" className="btn small" aria-pressed={zoomed} onClick={() => setZoomed(!zoomed)}>
            {zoomed ? 'Zoom out' : 'Zoom in'}
          </button>
          <button type="button" className="btn small" onClick={() => dialog.current.close()}>
            Close
          </button>
        </div>
        <div className="photo-viewer-stage" {...viewer.handlers}>
          <img
            src={images[selected]}
            alt={altOf(selected)}
            className={zoomed ? 'zoomed' : ''}
            style={{ transformOrigin: origin, transform: zoomed ? `scale(${ZOOM})` : 'none' }}
            onClick={(e) => {
              if (viewer.swiped()) return;
              setOrigin(originAt(e));
              setZoomed(!zoomed);
            }}
            onPointerMove={(e) => zoomed && setOrigin(originAt(e))}
          />
          {many && (
            <>
              <button type="button" className="photo-step prev" onClick={() => go(-1)} aria-label="Previous photo">
                ‹
              </button>
              <button type="button" className="photo-step next" onClick={() => go(1)} aria-label="Next photo">
                ›
              </button>
            </>
          )}
        </div>
      </dialog>
    </div>
  );
}
