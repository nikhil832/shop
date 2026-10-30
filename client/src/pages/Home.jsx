import { Link } from 'react-router';
import ProductRow from '../components/ProductRow.jsx';
import RecentlyViewed from '../components/RecentlyViewed.jsx';
import { CashIcon, ReturnIcon, ShieldIcon, TruckIcon } from '../components/Icons.jsx';
import { formatPrice } from '../format.js';
import { FREE_DELIVERY_MIN, RETURN_DAYS } from '../storeFacts.js';
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

// Products marked "Coming soon" (stage 92); nothing when there are none.
function ComingSoonRow() {
  const { data } = useFetch('/products?comingSoon=1&sort=newest&pageSize=8');
  if (!data?.items.length) return null;
  return <ProductRow title="Coming soon" items={data.items} />;
}

// What the store promises, with the numbers the server uses (storeFacts.js).
const PROMISES = [
  {
    Icon: TruckIcon,
    title: `Free delivery over ${formatPrice(FREE_DELIVERY_MIN)}`,
    text: 'To every PIN code we serve',
  },
  { Icon: ReturnIcon, title: `Easy ${RETURN_DAYS}-day returns`, text: 'Change of mind? Send it back' },
  { Icon: CashIcon, title: 'Cash on Delivery', text: 'Or pay online, as you like' },
  { Icon: ShieldIcon, title: 'Genuine products', text: 'Rated by real buyers' },
];

export default function Home() {
  const { data: categories, error } = useFetch('/categories');

  return (
    <>
      <section className="hero" aria-labelledby="hero-heading">
        <div className="hero-text">
          <p className="hero-kicker">Bazaar · shop everything in one place</p>
          <h1 id="hero-heading">Everything you need, delivered.</h1>
          <p>Mobiles, laptops, fashion, home essentials and more, at prices you&apos;ll like.</p>
          <div className="hero-actions">
            <Link to="/search" className="btn hero-primary">
              Shop all products
            </Link>
            <Link to="/search?sort=newest" className="btn hero-secondary">
              See what&apos;s new
            </Link>
          </div>
        </div>
        {/* The category pictures as a decoration beside the words, on wider screens. */}
        {categories?.length > 0 && (
          <div className="hero-art" aria-hidden="true">
            {categories.slice(0, 6).map((c) => (
              <img key={c.id} src={c.image} alt="" width="96" height="96" />
            ))}
          </div>
        )}
      </section>

      <ul className="promises" aria-label="Why shop with us">
        {PROMISES.map(({ Icon, title, text }) => (
          <li key={title}>
            <span className="promise-icon">
              <Icon />
            </span>
            <span>
              <strong>{title}</strong>
              <span className="muted small block">{text}</span>
            </span>
          </li>
        ))}
      </ul>

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
      <ListRow
        title="Biggest discounts"
        path="/products?deals=1&sort=discount&inStock=1&pageSize=8"
        moreLink="/search?deals=1&sort=discount"
      />
      <ListRow title="New arrivals" path="/products?sort=newest&pageSize=8" moreLink="/search?sort=newest" />
      <ComingSoonRow />
    </>
  );
}
