import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { formatPrice } from '../format.js';
import { SearchIcon } from './Icons.jsx';
import { useFetch } from '../useFetch.js';

// Suggestions are asked for once typing pauses this long, and only from this many characters.
const DELAY_MS = 150;
const MIN_LENGTH = 2;

const searchUrl = (q) => (q ? `/search?q=${encodeURIComponent(q)}` : '/search');

// The header's search box. While typing it suggests categories and products (a combobox: arrow keys move through
// them, Enter opens the highlighted one or searches, Escape closes). `initial` is the query in the URL.
export default function SearchBox({ initial }) {
  const navigate = useNavigate();
  const listId = useId();
  const [text, setText] = useState(initial);
  // What suggestions are shown for: the text, set a moment after typing stops (from the handlers, not an effect).
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const q = query.trim();
  const { data } = useFetch(open && q.length >= MIN_LENGTH ? `/search/suggest?q=${encodeURIComponent(q)}` : null);
  const options =
    open && q.length >= MIN_LENGTH && data
      ? [
          ...data.categories.map((c) => ({ key: `c-${c.slug}`, to: `/search?category=${c.slug}`, category: c })),
          ...data.products.map((p) => ({ key: `p-${p.slug}`, to: `/p/${p.slug}`, product: p })),
          ...(data.total > 0 ? [{ key: 'all', to: searchUrl(q), total: data.total }] : []),
        ]
      : [];

  function close() {
    setOpen(false);
    setActive(-1);
  }

  function go(option) {
    close();
    navigate(option.to);
  }

  function change(e) {
    const value = e.target.value;
    setText(value);
    setOpen(true);
    setActive(-1);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setQuery(value), DELAY_MS);
  }

  function keyDown(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!options.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      // Cycles through "nothing highlighted" (-1, the text box itself) and each option, wrapping at both ends.
      const positions = options.length + 1;
      setActive((a) => ((a + 1 + step + positions) % positions) - 1);
    } else if (e.key === 'Escape' && options.length) {
      e.preventDefault(); // otherwise the browser also clears the box
      close();
    } else if (e.key === 'Enter' && options[active]) {
      e.preventDefault();
      go(options[active]);
    }
  }

  function submit(e) {
    e.preventDefault();
    close();
    navigate(searchUrl(text.trim()));
  }

  return (
    <form className="search-form" role="search" onSubmit={submit}>
      <input
        name="q"
        type="search"
        placeholder="Search for products and brands"
        aria-label="Search products"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={options.length > 0}
        aria-controls={listId}
        aria-activedescendant={options[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        value={text}
        onChange={change}
        onKeyDown={keyDown}
        onFocus={() => {
          setOpen(true);
          setQuery(text);
        }}
        onBlur={close}
      />
      <button type="submit" aria-label="Search">
        <SearchIcon />
      </button>
      {options.length > 0 && (
        // mousedown would blur the box (closing the list) before the click lands.
        <ul
          id={listId}
          role="listbox"
          aria-label="Search suggestions"
          className="suggestions"
          onMouseDown={(e) => e.preventDefault()}
        >
          {options.map((o, i) => (
            <li
              key={o.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : undefined}
              onClick={() => go(o)}
              onMouseMove={() => i !== active && setActive(i)}
            >
              {o.category && (
                <>
                  <span>{o.category.name}</span>
                  <span className="muted small">Category</span>
                </>
              )}
              {o.product && (
                <>
                  <span className="suggestion-title">{o.product.title}</span>
                  <span className="muted small">{formatPrice(o.product.price)}</span>
                </>
              )}
              {o.total && (
                <strong>
                  See all {o.total} {o.total === 1 ? 'result' : 'results'} for “{q}”
                </strong>
              )}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
