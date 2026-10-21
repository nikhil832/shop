// The green average badge, with the number of ratings in brackets unless `count` is false.
export default function Rating({ rating, count = true }) {
  if (!rating?.count) return null;
  return (
    <span className="rating">
      <span className="rating-badge" aria-label={`Rated ${rating.avg} out of 5`}>
        {rating.avg.toFixed(1)} ★
      </span>
      {count && <span className="muted">({rating.count.toLocaleString('en-IN')})</span>}
    </span>
  );
}
