import { Link, useParams } from 'react-router';
import ProductCard from '../components/ProductCard.jsx';
import { formatDate, formatTime } from '../format.js';
import { useFetch } from '../useFetch.js';
import NotFound from './NotFound.jsx';

// A collection's page (/c/:slug, stage 91): the products an admin picked, in their order. Admins can look at one that
// isn't live yet (or has ended, or is switched off); everyone else gets "not found".
export default function Collection() {
  const { slug } = useParams();
  const { data, error } = useFetch(`/collections/${encodeURIComponent(slug)}`);

  if (error?.status === 404) return <NotFound message="This collection isn't available." />;
  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  return (
    <>
      <title>{`${data.name} · Bazaar`}</title>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/">Home</Link>
        <span aria-hidden>›</span>
        <span>{data.name}</span>
      </nav>
      {!data.live && (
        <p className="notice" role="status">
          Only admins can see this: the collection isn&rsquo;t live (switched off, not started or ended).
        </p>
      )}
      <section className="collection-head">
        <h1>{data.name}</h1>
        {data.description && <p>{data.description}</p>}
        {data.endsAt && (
          <p className="muted small">
            Until {formatDate(data.endsAt)}, {formatTime(data.endsAt)}
          </p>
        )}
      </section>
      {data.items.length === 0 ? (
        <p className="muted">Nothing here right now.</p>
      ) : (
        <div className="product-grid">
          {data.items.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      )}
    </>
  );
}
