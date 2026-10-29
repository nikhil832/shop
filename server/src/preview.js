import express from 'express';
import { liveFilter } from './collections.js';

// Link previews and search engines. WhatsApp, Instagram, Facebook and the like read a shared link's HTML without running JavaScript, so
// the built index.html (a blank page the React app fills in) would preview as just "Bazaar". These routes send it with
// Open Graph tags filled in on the server: the product's name, price, description and photo for /p/:slug, and the
// store's own for every other page. Product pages also carry schema.org data (price, stock, rating) for Google's
// results, and /robots.txt and /sitemap.xml list what to crawl. Only used in production, where index.js serves the
// built client.

const DEFAULT_IMAGE = '/og-image.png'; // client/public: 1200×630, the store's name
const SITE = 'Bazaar';
const SITE_DESCRIPTION = 'Mobiles, laptops, audio, fashion, home and books. A demo store: nothing is really sold.';
// Previews can't show SVG, so the sample catalog's generated pictures give way to the default image.
const UPLOADED = /^\/api\/images\/[0-9a-f]{24}$/;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

// The page's own address, from the request: behind Render's proxy (trust proxy) that is https://<the site>.
const originOf = (req) => `${req.protocol}://${req.get('host')}`;

// The <meta> tags for a page. `image` and `url` are absolute.
export function previewTags({ title, description, image, url, type = 'website' }) {
  const tags = [
    ['name', 'description', description],
    ['property', 'og:site_name', SITE],
    ['property', 'og:type', type],
    ['property', 'og:title', title],
    ['property', 'og:description', description],
    ['property', 'og:url', url],
    ['property', 'og:image', image],
    ['name', 'twitter:card', 'summary_large_image'],
  ];
  return tags.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${escapeHtml(value)}" />`).join('\n    ');
}

// The built index.html with this page's title and tags in its <head>, plus, for a product, its canonical address and
// structured data for search engines (`jsonLd`).
export function withPreview(html, { title, jsonLd, ...tags }) {
  const extra = jsonLd
    ? `\n    <link rel="canonical" href="${escapeHtml(tags.url)}" />` +
      // JSON can't end the script early once every "<" is escaped (an admin could type "</script>" in a title).
      `\n    <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`
    : '';
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace('</head>', `    ${previewTags({ title, ...tags })}${extra}\n  </head>`);
}

// Proves to Google Search Console that the site is ours (GOOGLE_SITE_VERIFICATION); on every page, so the home page has it.
export function withSiteVerification(html, code) {
  if (!code) return html;
  return html.replace(
    '</head>',
    `    <meta name="google-site-verification" content="${escapeHtml(code)}" />\n  </head>`,
  );
}

const rupees = (paise) => (paise / 100).toFixed(2);
const IN_STOCK = 'https://schema.org/InStock';
const OUT_OF_STOCK = 'https://schema.org/OutOfStock';

// What Google reads for a product result (schema.org Product): name, brand, uploaded photos, price in rupees (a range
// when variants differ), stock, and the rating when there is one. SVG placeholders are left out, as for previews.
export function productJsonLd(product, origin) {
  const url = `${origin}/p/${product.slug}`;
  const prices = product.variants?.length ? product.variants.map((v) => v.price) : [product.price];
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const availability = product.stock > 0 ? IN_STOCK : OUT_OF_STOCK;
  const images = product.images.filter((src) => UPLOADED.test(src)).map((src) => `${origin}${src}`);
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title,
    ...(product.description && { description: product.description }),
    brand: { '@type': 'Brand', name: product.brand },
    ...(images.length && { image: images }),
    url,
    offers:
      low === high
        ? { '@type': 'Offer', price: rupees(low), priceCurrency: 'INR', availability, url }
        : {
            '@type': 'AggregateOffer',
            lowPrice: rupees(low),
            highPrice: rupees(high),
            offerCount: prices.length,
            priceCurrency: 'INR',
            availability,
            url,
          },
    ...(product.rating?.count > 0 && {
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: product.rating.avg,
        ratingCount: product.rating.count,
      },
    }),
  };
}

// Pages that are only for one visitor (account, cart, orders…) or the admin panel: not for search engines.
export const PRIVATE_PATHS = [
  '/admin',
  '/account',
  '/cart',
  '/checkout',
  '/orders',
  '/wishlist',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/confirm-email',
  // Any mix of products (stage 73): endless addresses with nothing new on them.
  '/compare',
  '/api/',
];

export function robotsTxt(origin) {
  return [
    'User-agent: *',
    ...PRIVATE_PATHS.map((p) => `Disallow: ${p}`),
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}

const escapeXml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

// The pages worth finding: the home page, each category's listing, live collections (stage 91) and every shown
// product (with when they last changed).
export function sitemapXml(origin, { categories, products, collections = [] }) {
  const url = (path, lastmod) =>
    `  <url><loc>${escapeXml(origin + path)}</loc>${lastmod ? `<lastmod>${lastmod.toISOString()}</lastmod>` : ''}</url>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    url('/'),
    ...categories.map((c) => url(`/search?category=${encodeURIComponent(c.slug)}`)),
    ...collections.map((c) => url(`/c/${encodeURIComponent(c.slug)}`, c.updatedAt)),
    ...products.map((p) => url(`/p/${encodeURIComponent(p.slug)}`, p.updatedAt)),
    '</urlset>',
    '',
  ].join('\n');
}

// What a product's preview says: "Stride Running Shoes · ₹2,499" (from ₹… with variants at different prices), its
// brand and first highlights, and its first uploaded photo.
export function productPreview(product, origin) {
  const from = product.variants?.some((v) => v.price !== product.price) ? 'from ' : '';
  const price = `${from}${inr.format(product.price / 100)}`;
  const stock = product.stock === 0 ? ' · Out of stock' : '';
  const photo = product.images.find((src) => UPLOADED.test(src));
  return {
    title: `${product.title} · ${price}`,
    description: [`${product.brand}${stock}`, ...(product.highlights ?? []).slice(0, 3)].join(' · '),
    image: `${origin}${photo ?? DEFAULT_IMAGE}`,
    url: `${origin}/p/${product.slug}`,
    type: 'product',
  };
}

// A collection's preview (stage 91): its name, its description (or how many products), and the first uploaded photo
// of its shown products.
export function collectionPreview(collection, photo, count, origin) {
  return {
    title: `${collection.name} · ${SITE}`,
    description: collection.description || `${count} ${count === 1 ? 'product' : 'products'} picked by ${SITE}.`,
    image: `${origin}${photo ?? DEFAULT_IMAGE}`,
    url: `${origin}/c/${collection.slug}`,
  };
}

// Serves the client's index.html (read once, `html`) for every page, with link-preview tags.
export function previewRouter({ db, config }, page) {
  const html = withSiteVerification(page, config?.googleSiteVerification);
  const products = db.collection('products');
  const router = express.Router();
  const send = (res, status, page) => res.status(status).type('html').set('Cache-Control', 'no-cache').send(page);

  router.get('/p/:slug', async (req, res) => {
    const origin = originOf(req);
    const product = await products.findOne(
      { slug: req.params.slug, active: true },
      {
        projection: {
          title: 1,
          brand: 1,
          slug: 1,
          price: 1,
          stock: 1,
          images: 1,
          highlights: 1,
          description: 1,
          rating: 1,
          'variants.price': 1,
        },
      },
    );
    if (!product) {
      // The app shows its own "not found"; previews and search engines get the status too.
      return send(res, 404, withPreview(html, siteTags(req, 'Product not found · Bazaar')));
    }
    send(res, 200, withPreview(html, { ...productPreview(product, origin), jsonLd: productJsonLd(product, origin) }));
  });

  // Only live collections (collections.js); others are "not found" here, as for visitors.
  router.get('/c/:slug', async (req, res) => {
    const origin = originOf(req);
    const collection = await db.collection('collections').findOne({ slug: req.params.slug, ...liveFilter(new Date()) });
    if (!collection) return send(res, 404, withPreview(html, siteTags(req, 'Collection not found · Bazaar')));
    const shown = await products
      .find({ _id: { $in: collection.productIds }, active: true }, { projection: { images: 1 } })
      .toArray();
    const byId = new Map(shown.map((p) => [p._id.toString(), p]));
    const photo = collection.productIds
      .flatMap((id) => byId.get(id.toString())?.images ?? [])
      .find((src) => UPLOADED.test(src));
    send(res, 200, withPreview(html, collectionPreview(collection, photo, shown.length, origin)));
  });

  // For search engines. Both name this site's own address, so they're made per request like the previews.
  router.get('/robots.txt', (req, res) => {
    res
      .type('text/plain')
      .set('Cache-Control', 'public, max-age=3600')
      .send(robotsTxt(originOf(req)));
  });

  router.get('/sitemap.xml', async (req, res) => {
    const [categoryDocs, productDocs, collectionDocs] = await Promise.all([
      db
        .collection('categories')
        .find({}, { projection: { slug: 1 } })
        .sort({ sortOrder: 1, name: 1 })
        .toArray(),
      products
        .find({ active: true }, { projection: { slug: 1, updatedAt: 1 } })
        .sort({ _id: 1 })
        .toArray(),
      db
        .collection('collections')
        .find(liveFilter(new Date()), { projection: { slug: 1, updatedAt: 1 } })
        .sort({ position: 1 })
        .toArray(),
    ]);
    res
      .type('application/xml')
      .set('Cache-Control', 'public, max-age=3600')
      .send(
        sitemapXml(originOf(req), { categories: categoryDocs, products: productDocs, collections: collectionDocs }),
      );
  });

  router.get('/{*splat}', (req, res) => send(res, 200, withPreview(html, siteTags(req))));
  return router;
}

function siteTags(req, title = SITE) {
  const origin = originOf(req);
  return { title, description: SITE_DESCRIPTION, image: `${origin}${DEFAULT_IMAGE}`, url: `${origin}${req.path}` };
}
