import { Link } from 'react-router';
import FaqList from '../components/FaqList.jsx';

// /faq (stage 130): the store's questions and answers, with a search, and a way to ask when none of them helps.
export default function Faq() {
  return (
    <div className="orders-page faq-page">
      <section className="panel account-section" aria-labelledby="faq-heading">
        <h1 id="faq-heading">Questions and answers</h1>
        <FaqList />
        <p className="faq-ask">
          Didn&apos;t find what you need? <Link to="/help">Write to us</Link> and we&apos;ll reply within a working day.
        </p>
      </section>
    </div>
  );
}
