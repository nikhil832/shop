// Product performance (stage 100): the product page tells the store about a view (once per page load) and a click on
// "Add to cart", so admins can see what is looked at but not bought. Fire and forget: `keepalive` lets it finish if
// the visitor leaves at once, and a failure changes nothing for them. Nothing about the visitor is sent.
export function reportSeen(slug, event) {
  fetch(`/api/products/${encodeURIComponent(slug)}/seen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event }),
    keepalive: true,
  }).catch(() => {});
}
