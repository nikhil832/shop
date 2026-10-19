export default function Rating({ rating }) {
  if (!rating?.count) return null;
  return (
    <span className="rating">
      <span className="rating-badge" aria-label={`Rated ${rating.avg} out of 5`}>
        {rating.avg.toFixed(1)} ★
      </span>
      <span className="muted">({rating.count.toLocaleString('en-IN')})</span>
    </span>
  );
}
