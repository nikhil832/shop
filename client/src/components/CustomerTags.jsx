// A customer's tags (stage 82, Admin → Customers) as small badges beside their name in the admin panel.
export const CUSTOMER_TAGS = { vip: 'VIP', wholesale: 'Wholesale', watch: 'Watch' };

export default function CustomerTags({ tags }) {
  if (!tags?.length) return null;
  return (
    <span className="customer-tags">
      {tags.map((t) => (
        <span key={t} className={`customer-tag ${t}`}>
          {CUSTOMER_TAGS[t] ?? t}
        </span>
      ))}
    </span>
  );
}
