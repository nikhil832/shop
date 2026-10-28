import { Link, useSearchParams } from 'react-router';
import { query } from '../../api.js';
import Pager from '../../components/Pager.jsx';
import { formatDate, formatPrice } from '../../format.js';
import { useFetch } from '../../useFetch.js';
import CustomerTags, { CUSTOMER_TAGS } from '../../components/CustomerTags.jsx';

const SORTS = { recent: 'Newest accounts', spent: 'Most spent', last_order: 'Latest order' };
const ROLES = { admin: 'Admin', packer: 'Packer', support: 'Support' };

// Admin → Customers (stage 74): every account with what it has bought. "Spent" is sold orders less refunds.
export default function AdminCustomers() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'recent';
  const tag = params.get('tag') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const { data, error, loading } = useFetch(
    `/admin/customers${query({ q, tag, sort: sort === 'recent' ? '' : sort, page: page > 1 ? page : '' })}`,
  );
  const update = (changes) => {
    const next = { q, tag, sort: sort === 'recent' ? '' : sort, ...changes };
    setParams(query({ ...next, page: changes.page > 1 ? changes.page : '' }).slice(1));
  };

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Customers</h1>
      </div>
      <p className="muted small">
        Every account, with its orders and what it has spent (orders placed, shipped or delivered, less refunds). Open
        one for its orders, returns, help requests and store credit.
      </p>
      <div className="admin-filters">
        {/* Remounted when the address changes, so the box shows the search in it. */}
        <form
          key={q}
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: new FormData(e.currentTarget).get('q').trim() });
          }}
        >
          <input name="q" type="search" defaultValue={q} placeholder="Name or email" aria-label="Search customers" />{' '}
          <button type="submit" className="btn small">
            Search
          </button>
        </form>
        <select aria-label="Tag" value={tag} onChange={(e) => update({ tag: e.target.value })}>
          <option value="">Any tag</option>
          {Object.entries(CUSTOMER_TAGS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select aria-label="Sort by" value={sort} onChange={(e) => update({ sort: e.target.value })}>
          {Object.entries(SORTS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="error">{error.message}</p>}
      {data?.items.length === 0 && <p className="muted">{q ? `No one matches “${q}”.` : 'No accounts yet.'}</p>}
      {data?.items.length > 0 && (
        <div className="table-wrap">
          <table className={`admin-table ${loading ? 'stale' : ''}`}>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Joined</th>
                <th className="num">Orders</th>
                <th className="num">Spent</th>
                <th>Last order</th>
                <th className="num">Store credit</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/admin/customers/${c.id}`}>{c.name}</Link>
                    <CustomerTags tags={c.tags} />
                    {ROLES[c.role] && <span className="status small"> {ROLES[c.role]}</span>}
                    <span className="muted small block">{c.email}</span>
                  </td>
                  <td>{formatDate(c.createdAt)}</td>
                  <td className="num">{c.orders}</td>
                  <td className="num">{formatPrice(c.spent)}</td>
                  <td>{c.lastOrderAt ? formatDate(c.lastOrderAt) : <span className="muted">—</span>}</td>
                  <td className="num">{c.credit ? formatPrice(c.credit) : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pager page={page} total={data.total} pageSize={data.pageSize} onPage={(p) => update({ page: p })} />}
    </section>
  );
}
