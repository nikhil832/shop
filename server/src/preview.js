import express from 'express';

// Link previews. WhatsApp, Instagram, Facebook and the like read a shared link's HTML without running JavaScript, so
// the built index.html (a blank page the React app fills in) would preview as just "Bazaar". These routes send it with
// Open Graph tags filled in on the server: the product's name, price, description and photo for /p/:slug, and the
// store's own for every other page. Only used in production, where index.js serves the built client.

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

// The built index.html with this page's title and tags in its <head>.
export function withPreview(html, { title, ...tags }) {
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace('</head>', `    ${previewTags({ title, ...tags })}\n  </head>`);
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

// Serves the client's index.html (read once, `html`) for every page, with link-preview tags.
export function previewRouter({ db }, html) {
  const products = db.collection('products');
  const router = express.Router();
  const send = (res, status, page) => res.status(status).type('html').set('Cache-Control', 'no-cache').send(page);

  router.get('/p/:slug', async (req, res) => {
    const origin = originOf(req);
    const product = await products.findOne(
      { slug: req.params.slug, active: true },
      {
        projection: { title: 1, brand: 1, slug: 1, price: 1, stock: 1, images: 1, highlights: 1, 'variants.price': 1 },
      },
    );
    if (!product) {
      // The app shows its own "not found"; previews and search engines get the status too.
      return send(res, 404, withPreview(html, siteTags(req, 'Product not found · Bazaar')));
    }
    send(res, 200, withPreview(html, productPreview(product, origin)));
  });

  router.get('/{*splat}', (req, res) => send(res, 200, withPreview(html, siteTags(req))));
  return router;
}

function siteTags(req, title = SITE) {
  const origin = originOf(req);
  return { title, description: SITE_DESCRIPTION, image: `${origin}${DEFAULT_IMAGE}`, url: `${origin}${req.path}` };
}
