// A review's stars, e.g. ★★★★☆ for 4.
export default function Stars({ rating }) {
  return (
    <span className="stars" role="img" aria-label={`${rating} out of 5 stars`}>
      {'★'.repeat(rating)}
      <span className="stars-off">{'★'.repeat(5 - rating)}</span>
    </span>
  );
}
