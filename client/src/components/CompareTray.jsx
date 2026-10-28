import { Link, useLocation } from 'react-router';
import { clearCompare, compareLink, removeFromCompare, useCompare } from '../compare.js';

// Not on the comparison itself, in the admin panel, at checkout or on printed pages.
const HIDDEN_ON = /^\/(admin|checkout|compare)(\/|$)|^\/orders\/[^/]+\/(invoice|credit-notes)/;

// The products chosen for comparing, across the bottom of the shop while there are any (stage 73).
export default function CompareTray() {
  const { pathname } = useLocation();
  const { items, startedOver } = useCompare();
  if (!items.length || HIDDEN_ON.test(pathname)) return null;
  return (
    <>
      {/* Room at the end of the page, so the tray never covers the footer. */}
      <div className="compare-tray-space no-print" />
      <aside className="compare-tray no-print" aria-label="Products to compare">
        <div className="compare-tray-items">
          {startedOver && (
            <p className="small">Products are compared within one category, so this starts a new list.</p>
          )}
          <ul>
            {items.map((p) => (
              <li key={p.slug}>
                <span className="compare-tray-title">{p.title}</span>
                <button
                  type="button"
                  className="link"
                  aria-label={`Remove ${p.title} from the comparison`}
                  onClick={() => removeFromCompare(p.slug)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="compare-tray-actions">
          {items.length < 2 ? (
            <span className="muted small">
              Choose {items.length === 1 ? 'one or two more' : 'up to three'} from this category
            </span>
          ) : (
            <Link to={compareLink(items)} className="btn primary small">
              Compare {items.length}
            </Link>
          )}
          <button type="button" className="link small" onClick={clearCompare}>
            Clear
          </button>
        </div>
      </aside>
    </>
  );
}
