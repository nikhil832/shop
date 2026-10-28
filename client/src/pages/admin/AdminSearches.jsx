import { Link, useSearchParams } from 'react-router';
import { query } from '../../api.js';
import { useFetch } from '../../useFetch.js';

const weekName = (iso) => {
  const day = (d) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const monday = new Date(`${iso}T00:00:00Z`);
  return `${day(monday)} to ${day(new Date(monday.getTime() + 6 * 86_400_000))}`;
};

function Terms({ items, empty, showFound }) {
  if (!items.length) return <p className="muted">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Search</th>
            <th className="num">Times</th>
            {showFound && <th className="num">Found</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.term}>
              <td>
                <Link to={`/search?q=${encodeURIComponent(s.term)}`}>{s.term}</Link>
              </td>
              <td className="num">{s.count}</td>
              {showFound && <td className="num">{s.found}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Admin → Searches (stage 76): what shoppers searched for in a week (Monday to Sunday, India time), and what found
// nothing. Words only; nothing about who searched.
export default function AdminSearches() {
  const [params, setParams] = useSearchParams();
  const week = params.get('week') ?? '';
  const { data, error, loading } = useFetch(`/admin/search-insights${query({ week })}`);

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Searches</h1>
        {data && (
          <select
            aria-label="Week"
            value={data.week}
            onChange={(e) => setParams(e.target.value === data.weeks[0] ? {} : { week: e.target.value })}
          >
            {data.weeks.map((w, i) => (
              <option key={w} value={w}>
                {i === 0 ? `This week (${weekName(w)})` : weekName(w)}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="muted small">
        What shoppers typed in the search box, by its words (paging, sorting and filters don&apos;t count again).
        Searches that found nothing show what people want that the store doesn&apos;t have, or words to add to product
        titles and highlights. Kept for six months; nothing about who searched.
      </p>
      {error && <p className="error">{error.message}</p>}
      {data && (
        <div className={loading ? 'stale' : ''}>
          <dl className="customer-totals">
            <div>
              <dt>Searches</dt>
              <dd>{data.totals.searches}</dd>
            </div>
            <div>
              <dt>Different searches</dt>
              <dd>{data.totals.different}</dd>
            </div>
            <div>
              <dt>Found nothing</dt>
              <dd>{data.totals.nothingFound}</dd>
            </div>
          </dl>
          <div className="admin-columns">
            <section aria-labelledby="searches-nothing">
              <h2 id="searches-nothing">Found nothing</h2>
              <Terms items={data.nothingFound} empty="Every search found something." />
            </section>
            <section aria-labelledby="searches-top">
              <h2 id="searches-top">Most searched</h2>
              <Terms items={data.top} empty="No searches this week yet." showFound />
            </section>
          </div>
        </div>
      )}
    </section>
  );
}
