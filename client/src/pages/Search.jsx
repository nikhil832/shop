import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { query } from '../api.js';
import ProductCard from '../components/ProductCard.jsx';
import { useFetch } from '../useFetch.js';

export const SORTS = [
  { id: 'relevance', label: 'Popularity' },
  { id: 'price_asc', label: 'Price: low to high' },
  { id: 'price_desc', label: 'Price: high to low' },
  { id: 'newest', label: 'Newest first' },
  { id: 'rating', label: 'Customer rating' },
];
const PAGE_SIZE = 24;

// URL prices are whole rupees (readable, shareable); the API takes paise.
const toPaise = (rupees) => (rupees ? String(Math.round(Number(rupees) * 100)) : undefined);

function PriceFilter({ min, max, onApply }) {
  function submit(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    onApply(form.get('min').trim(), form.get('max').trim());
  }
  return (
    // Remounted when the URL values change so the inputs show them.
    <form key={`${min}-${max}`} className="price-filter" onSubmit={submit}>
      <input name="min" type="number" min="0" placeholder="Min ₹" aria-label="Minimum price" defaultValue={min} />
      <span aria-hidden>–</span>
      <input name="max" type="number" min="0" placeholder="Max ₹" aria-label="Maximum price" defaultValue={max} />
      <button type="submit" className="btn small">
        Go
      </button>
    </form>
  );
}

export default function Search() {
  const [params, setParams] = useSearchParams();
  const [filtersOpen, setFiltersOpen] = useState(() => window.matchMedia('(min-width: 800px)').matches);
  const get = (k) => params.get(k) ?? '';
  const q = get('q');
  const category = get('category');
  const brands = get('brand') ? get('brand').split(',') : [];
  const sort = SORTS.some((s) => s.id === get('sort')) ? get('sort') : 'relevance';
  const page = Math.max(1, Number(get('page')) || 1);

  const { data: categories } = useFetch('/categories');
  const { data, error, loading } = useFetch(
    `/products${query({
      q,
      category,
      brand: brands.join(','),
      minPrice: toPaise(get('minPrice')),
      maxPrice: toPaise(get('maxPrice')),
      rating: get('rating'),
      inStock: get('inStock'),
      sort,
      page,
      pageSize: PAGE_SIZE,
    })}`,
  );

  // Changing any filter returns to page 1.
  function update(changes) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next);
  }

  const toggleBrand = (name) =>
    update({ brand: (brands.includes(name) ? brands.filter((b) => b !== name) : [...brands, name]).join(',') });

  const categoryName = categories?.find((c) => c.slug === category)?.name;
  const heading = q ? `Results for “${q}”` : (categoryName ?? 'All products');
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const hasFilters = ['brand', 'minPrice', 'maxPrice', 'rating', 'inStock'].some((k) => params.has(k));

  return (
    <div className="search-page">
      <aside className="filters">
        <button
          type="button"
          className="filters-toggle"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((o) => !o)}
        >
          Filters {filtersOpen ? '▴' : '▾'}
        </button>
        {filtersOpen && (
          <div className="filters-body">
            {hasFilters && (
              <button
                type="button"
                className="link"
                onClick={() => update({ brand: '', minPrice: '', maxPrice: '', rating: '', inStock: '' })}
              >
                Clear filters
              </button>
            )}

            <fieldset>
              <legend>Category</legend>
              <ul className="filter-links">
                <li>
                  <Link to={`/search${query({ q })}`} className={!category ? 'active' : ''}>
                    All
                  </Link>
                </li>
                {categories?.map((c) => (
                  <li key={c.id}>
                    <Link
                      to={`/search${query({ q, category: c.slug })}`}
                      className={category === c.slug ? 'active' : ''}
                    >
                      {c.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </fieldset>

            {data?.brands.length > 0 && (
              <fieldset>
                <legend>Brand</legend>
                {data.brands.map((b) => (
                  <label key={b.name} className="check">
                    <input type="checkbox" checked={brands.includes(b.name)} onChange={() => toggleBrand(b.name)} />
                    {b.name} <span className="muted">({b.count})</span>
                  </label>
                ))}
              </fieldset>
            )}

            <fieldset>
              <legend>Price</legend>
              <PriceFilter
                min={get('minPrice')}
                max={get('maxPrice')}
                onApply={(minPrice, maxPrice) => update({ minPrice, maxPrice })}
              />
            </fieldset>

            <fieldset>
              <legend>Customer rating</legend>
              {['4', '3'].map((r) => (
                <label key={r} className="check">
                  <input
                    type="radio"
                    name="rating"
                    checked={get('rating') === r}
                    onChange={() => update({ rating: r })}
                  />
                  {r}★ &amp; above
                </label>
              ))}
              {get('rating') && (
                <button type="button" className="link" onClick={() => update({ rating: '' })}>
                  Any rating
                </button>
              )}
            </fieldset>

            <fieldset>
              <legend>Availability</legend>
              <label className="check">
                <input
                  type="checkbox"
                  checked={get('inStock') === '1'}
                  onChange={(e) => update({ inStock: e.target.checked ? '1' : '' })}
                />
                In stock only
              </label>
            </fieldset>
          </div>
        )}
      </aside>

      <section className="results" aria-busy={loading}>
        <div className="results-header">
          <div>
            <h1>{heading}</h1>
            {data && (
              <span className="muted">
                {data.total.toLocaleString('en-IN')} {data.total === 1 ? 'product' : 'products'}
              </span>
            )}
          </div>
          <select value={sort} onChange={(e) => update({ sort: e.target.value })} aria-label="Sort by">
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {/* With a search, the default order is by how well products match (popularity breaks ties). */}
                Sort: {s.id === 'relevance' && q ? 'Relevance' : s.label}
              </option>
            ))}
          </select>
        </div>

        {error && <p className="error">{error.message}</p>}
        {data && data.total === 0 && (
          <div className="empty-state">
            <h2>No products found</h2>
            <p className="muted">Try a different search or remove some filters.</p>
          </div>
        )}
        <div className={`product-grid ${loading ? 'stale' : ''}`}>
          {data?.items.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>

        {pages > 1 && (
          <nav className="pagination" aria-label="Pages">
            <button
              type="button"
              className="btn"
              disabled={page <= 1}
              onClick={() => update({ page: page - 1 > 1 ? String(page - 1) : '' })}
            >
              ‹ Previous
            </button>
            <span>
              Page {page} of {pages}
            </span>
            <button
              type="button"
              className="btn"
              disabled={page >= pages}
              onClick={() => update({ page: String(page + 1) })}
            >
              Next ›
            </button>
          </nav>
        )}
      </section>
    </div>
  );
}
