// An order marked as a gift (stage 104): its message and whether it's gift wrapped, on the customer's and the admin's
// order pages.
export default function GiftDetails({ gift }) {
  return (
    <section className="panel gift-details" aria-labelledby="gift-details-heading">
      <h2 id="gift-details-heading">Gift</h2>
      <p>{gift.wrap ? 'Gift wrapped, with no prices on the packing slip.' : 'No prices on the packing slip.'}</p>
      {gift.message ? <blockquote>{gift.message}</blockquote> : <p className="muted small">No gift message.</p>}
    </section>
  );
}
