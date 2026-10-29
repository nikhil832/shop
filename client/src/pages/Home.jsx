import { Link } from 'react-router';
import ProductRow from '../components/ProductRow.jsx';
import RecentlyViewed from '../components/RecentlyViewed.jsx';
import { useFetch } from '../useFetch.js';

function ListRow({ title, path, moreLink }) {
  const { data, error } = useFetch(path);
  return <ProductRow title={title} items={data?.items} error={error} moreLink={moreLink} />;
}

// Live collections marked for the home page (stage 91), each a row with "View all" to its page.
function CollectionRows() {
  const { data } = useFetch('/collections/home');
  return data?.items.map((c) => <ProductRow key={c.slug} title={c.name} items={c.items} moreLink={`/c/${c.slug}`} />);
}

export default function Home() {
  const { data: categories, error } = useFetch('/categories');

  return (
    <>
      <section className="hero">
        <h1>Everything you need, delivered.</h1>
        <p>Mobiles, laptops, fashion, home essentials and more, at prices you'll like.</p>
        <Link to="/search" className="btn primary">
          Shop all products
        </Link>
      </section>

      {error && <p className="error">{error.message}</p>}
      <nav className="category-grid" aria-label="Categories">
        {categories?.map((c) => (
          <Link key={c.id} to={`/search?category=${c.slug}`} className="category-tile">
            <img src={c.image} alt="" width="120" height="120" />
            <span>{c.name}</span>
          </Link>
        ))}
      </nav>

      <CollectionRows />
      <RecentlyViewed />
      <ListRow title="Top rated" path="/products?sort=rating&inStock=1&pageSize=8" moreLink="/search?sort=rating" />
      <ListRow title="New arrivals" path="/products?sort=newest&pageSize=8" moreLink="/search?sort=newest" />
    </>
  );
}
