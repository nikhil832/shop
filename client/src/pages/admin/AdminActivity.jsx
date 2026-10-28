import { Link, useSearchParams } from 'react-router';
import { query } from '../../api.js';
import { formatDate, formatTime } from '../../format.js';
import { useFetch } from '../../useFetch.js';
import Pager from '../../components/Pager.jsx';

const AREAS = {
  products: 'Products',
  categories: 'Categories',
  orders: 'Orders',
  returns: 'Returns',
  reviews: 'Reviews',
  questions: 'Questions',
  coupons: 'Coupons',
  delivery: 'Delivery',
  settings: 'Settings',
  accounts: 'Accounts',
  errors: 'Errors',
  help: 'Help requests',
  sales: 'Sales',
  announcements: 'Announcements',
  giftCards: 'Gift cards',
};

const personName = (p) => (p ? p.name : 'Command line');

// "Price: ₹349 → ₹299", or "Category: Books" when there was nothing before.
const changeText = (c) => `${c.field}: ${'from' in c ? `${c.from || '(empty)'} → ` : ''}${c.to || '(empty)'}`;

function Entry({ entry }) {
  const { target } = entry;
  return (
    <li className="activity-entry">
      <div className="activity-meta muted small">
        <time dateTime={entry.at}>
          {formatDate(entry.at)}, {formatTime(entry.at)}
        </time>{' '}
        · {AREAS[entry.area]} · {personName(entry.by)}
      </div>
      <p>
        <strong>{entry.action}</strong>
        {target && (
          <>
            {': '}
            {target.path ? <Link to={target.path}>{target.label}</Link> : target.label}
          </>
        )}
      </p>
      {entry.changes.length > 0 && (
        <ul className="activity-changes small">
          {entry.changes.map((c, i) => (
            <li key={i}>{changeText(c)}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

export default function AdminActivity() {
  const [params, setParams] = useSearchParams();
  const area = params.get('area') ?? '';
  const by = params.get('by') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const { data, error, loading } = useFetch(`/admin/activity${query({ area, by, page: page > 1 ? page : '' })}`);

  // Any change other than the page goes back to page 1.
  const update = (changes) => {
    const next = { area, by, ...changes };
    setParams(query({ ...next, page: changes.page > 1 ? changes.page : '' }).slice(1));
  };

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Activity</h1>
      </div>
      <p className="muted small">
        Every change made in the admin panel, newest first: who made it, when, and what changed. Kept for a year.
      </p>
      <div className="admin-filters">
        <select aria-label="Area" value={area} onChange={(e) => update({ area: e.target.value })}>
          <option value="">Everything</option>
          {Object.entries(AREAS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select aria-label="Person" value={by} onChange={(e) => update({ by: e.target.value })}>
          <option value="">Everyone</option>
          {data?.people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id === 'cli' ? 'Command line' : `${p.name} (${p.email})`}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="error">{error.message}</p>}
      {data?.items.length === 0 && <p className="muted">Nothing recorded yet.</p>}
      {data?.items.length > 0 && (
        <ol className={`activity-list ${loading ? 'stale' : ''}`}>
          {data.items.map((e) => (
            <Entry key={e.id} entry={e} />
          ))}
        </ol>
      )}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={(p) => update({ page: p })} />}
    </section>
  );
}
