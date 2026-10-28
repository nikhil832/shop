import { useRef } from 'react';
import { useFetch } from '../useFetch.js';

// "Size guide" beside a product's options (stage 88): the chart its category (or the product itself) uses, in a
// dialog. Nothing when there's none. The browser's own <dialog> keeps focus inside and closes on Escape.
export default function SizeGuide({ slug }) {
  const { data } = useFetch(`/products/${slug}/size-guide`);
  const dialog = useRef(null);
  const guide = data?.guide;
  if (!guide) return null;
  return (
    <>
      <button type="button" className="link small size-guide-link" onClick={() => dialog.current.showModal()}>
        Size guide
      </button>
      <dialog ref={dialog} className="size-guide" aria-labelledby="size-guide-heading">
        <div className="row-header">
          <h2 id="size-guide-heading">{guide.name}</h2>
          <button type="button" className="btn small" onClick={() => dialog.current.close()}>
            Close
          </button>
        </div>
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                {guide.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {guide.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {guide.note && <p className="muted small">{guide.note}</p>}
      </dialog>
    </>
  );
}
