// Descriptions of a product's uploaded photos for screen readers (stage 59). Stored on the product by upload id
// (`imageAlts: { <id>: text }`, so a key never holds a slash or dot) and given out by photo address, only for photos the
// product still has. Its own module because both catalog.js and admin.js need it, and importing admin.js from
// catalog.js would make an import cycle through orders.js.

const uploadId = (url) => url.split('/').pop();

// From { <address>: text } as the admin form sends them, for the photos in `images`.
export function storedAlts(alts, images) {
  return Object.fromEntries(images.filter((url) => alts[url]).map((url) => [uploadId(url), alts[url]]));
}

// { <address>: text } for a product document's photos.
export function imageAltsOf(doc) {
  const alts = doc.imageAlts ?? {};
  return Object.fromEntries(doc.images.filter((url) => alts[uploadId(url)]).map((url) => [url, alts[uploadId(url)]]));
}
