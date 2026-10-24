import { clearRecentlyViewed, useRecentlyViewed } from '../recent.js';
import { useFetch } from '../useFetch.js';
import ProductRow from './ProductRow.jsx';

// The products this browser viewed lately, except `exclude` (the product page's own). Nothing at all when there are none.
export default function RecentlyViewed({ exclude }) {
  const slugs = useRecentlyViewed().filter((s) => s !== exclude);
  const { data } = useFetch(slugs.length ? `/recently-viewed?slugs=${slugs.join(',')}` : null);
  if (!slugs.length || !data?.items.length) return null;
  return (
    <ProductRow
      title="Recently viewed"
      items={data.items}
      action={
        <button type="button" className="link" onClick={clearRecentlyViewed}>
          Clear
        </button>
      }
    />
  );
}
