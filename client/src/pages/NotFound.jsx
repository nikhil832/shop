import { Link } from 'react-router';

export default function NotFound({ message = "We couldn't find that page." }) {
  return (
    <div className="empty-state">
      <h1>Not found</h1>
      <p>{message}</p>
      <Link to="/" className="btn primary">
        Back to home
      </Link>
    </div>
  );
}
