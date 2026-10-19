import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';

export default function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const urlQuery = location.pathname === '/search' ? (params.get('q') ?? '') : '';

  function submit(e) {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get('q').trim();
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
  }

  return (
    <header className="header">
      <div className="header-inner">
        <Link to="/" className="logo">
          Bazaar
        </Link>
        {/* Remounted when the URL's query changes (back/forward, category links) so the box shows it. */}
        <form key={urlQuery} className="search-form" role="search" onSubmit={submit}>
          <input
            name="q"
            type="search"
            placeholder="Search for products and brands"
            aria-label="Search products"
            defaultValue={urlQuery}
          />
          <button type="submit" aria-label="Search">
            🔍
          </button>
        </form>
      </div>
    </header>
  );
}
