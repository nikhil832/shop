// Previous / next buttons for a paged list; nothing when everything fits on one page.
export default function Pager({ page, total, pageSize, onPage }) {
  const pages = Math.ceil(total / pageSize);
  if (pages <= 1) return null;
  return (
    <div className="pagination">
      <button type="button" className="btn small" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ‹ Previous
      </button>
      <span className="muted">
        Page {page} of {pages}
      </span>
      <button type="button" className="btn small" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next ›
      </button>
    </div>
  );
}
