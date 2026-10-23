import { ObjectId } from 'mongodb';
import { pathToFileURL } from 'node:url';
import { optionsPhrase, variantLabel } from './variants.js';
import { connectDb } from './db.js';
import { loadConfig } from './config.js';

// Sample catalog with fictional brands. Prices in paise.
const CATEGORIES = [
  { slug: 'mobiles', name: 'Mobiles' },
  { slug: 'laptops', name: 'Laptops' },
  { slug: 'audio', name: 'Audio' },
  { slug: 'fashion', name: 'Fashion' },
  { slug: 'home-kitchen', name: 'Home & Kitchen' },
  { slug: 'books', name: 'Books' },
];

// Sample products with variants: [option name(s), [value(s), price ₹, mrp ₹, stock, photo views?]…]. The cheapest price and
// the total stock match the product's row below, so catalog counts and price filters are the same with or without
// them. Photo views pick from the product's own images (0–2) for that variant.
const VARIANTS = {
  'Stride Running Shoes': [
    'Size',
    [
      ['UK 7', 2499, 4499, 15],
      ['UK 8', 2499, 4499, 20],
      ['UK 9', 2499, 4499, 10],
      ['UK 10', 2499, 4499, 5],
    ],
  ],
  'Ziva Women Handbag': [
    'Colour',
    [
      ['Black', 1299, 2799, 12, [0, 2]],
      ['Tan', 1299, 2799, 10, [1]],
    ],
  ],
  // Two options: not every combination exists (no Black 34), and Blue 30 is sold out.
  'Urbane Men Slim Fit Jeans': [
    ['Colour', 'Waist'],
    [
      [['Blue', '30'], 1199, 2499, 0, [0]],
      [['Blue', '32'], 1199, 2499, 20, [0]],
      [['Blue', '34'], 1299, 2499, 14, [0]],
      [['Black', '30'], 1199, 2499, 12, [1]],
      [['Black', '32'], 1199, 2499, 18, [1]],
    ],
  ],
  'Urbane Women Kurta Set': [
    'Size',
    [
      ['S', 1499, 2999, 10],
      ['M', 1499, 2999, 12],
      ['L', 1499, 2999, 8],
      ['XL', 1599, 2999, 5],
    ],
  ],
};

// [category, brand, title, price ₹, mrp ₹, stock, highlights]
const PRODUCTS = [
  [
    'mobiles',
    'Voltix',
    'Voltix Nova 5G (8GB RAM, 128GB)',
    18999,
    22999,
    25,
    ['6.6" AMOLED display', '50MP dual camera', '5000mAh battery'],
  ],
  [
    'mobiles',
    'Voltix',
    'Voltix Nova Pro 5G (12GB RAM, 256GB)',
    27999,
    32999,
    12,
    ['120Hz AMOLED', '108MP camera', '67W fast charging'],
  ],
  [
    'mobiles',
    'Orbit',
    'Orbit A14 (4GB RAM, 64GB)',
    8999,
    10999,
    40,
    ['6.5" HD+ display', '13MP camera', '5000mAh battery'],
  ],
  ['mobiles', 'Orbit', 'Orbit X Fold', 89999, 99999, 3, ['Foldable 7.6" display', 'Triple camera', 'IPX4']],
  [
    'mobiles',
    'Pixelon',
    'Pixelon 9 (8GB RAM, 256GB)',
    54999,
    59999,
    0,
    ['Best-in-class camera', '7 years of updates', 'Wireless charging'],
  ],
  [
    'mobiles',
    'Pixelon',
    'Pixelon 9a (8GB RAM, 128GB)',
    34999,
    39999,
    18,
    ['Night mode camera', 'Clean software', '4500mAh battery'],
  ],
  ['mobiles', 'Kiran', 'Kiran K2 (6GB RAM, 128GB)', 11499, 13999, 30, ['90Hz display', '48MP camera', 'Dual SIM']],
  [
    'laptops',
    'Arcbook',
    'Arcbook Air 14 (16GB, 512GB SSD)',
    64990,
    74990,
    10,
    ['14" 2.8K display', '18-hour battery', '1.2 kg'],
  ],
  [
    'laptops',
    'Arcbook',
    'Arcbook Pro 16 (32GB, 1TB SSD)',
    149990,
    169990,
    4,
    ['16" mini-LED', '12-core CPU', '22-hour battery'],
  ],
  [
    'laptops',
    'Nimbus',
    'Nimbus Gamer 15 (RTX, 16GB, 1TB)',
    89990,
    109990,
    6,
    ['15.6" 165Hz', 'RTX graphics', 'RGB keyboard'],
  ],
  [
    'laptops',
    'Nimbus',
    'Nimbus Slim 13 (8GB, 512GB SSD)',
    42990,
    49990,
    15,
    ['13.3" FHD', 'Backlit keyboard', 'Fingerprint reader'],
  ],
  [
    'laptops',
    'Ferro',
    'Ferro WorkMate 14 (8GB, 256GB SSD)',
    32990,
    38990,
    20,
    ['14" FHD anti-glare', 'Spill-resistant keyboard', 'Wi-Fi 6'],
  ],
  ['laptops', 'Ferro', 'Ferro Chromebook 11', 17990, 21990, 0, ['11.6" HD', 'All-day battery', 'Lightweight']],
  [
    'audio',
    'Sonique',
    'Sonique Buds Pro (ANC)',
    4999,
    7999,
    60,
    ['Active noise cancellation', '30-hour battery', 'Bluetooth 5.3'],
  ],
  [
    'audio',
    'Sonique',
    'Sonique Studio Over-Ear Headphones',
    12999,
    16999,
    14,
    ['Hi-Res audio', '40mm drivers', 'Foldable'],
  ],
  ['audio', 'Bolt', 'Bolt Bass Neckband', 1299, 2499, 80, ['Deep bass', '20-hour battery', 'Magnetic earbuds']],
  ['audio', 'Bolt', 'Bolt Party Speaker 40W', 5499, 8999, 9, ['40W output', 'RGB lights', 'IPX5 splash-proof']],
  [
    'audio',
    'Tarang',
    'Tarang Mini Bluetooth Speaker',
    1499,
    2999,
    45,
    ['Pocket-size', '10-hour battery', 'Built-in mic'],
  ],
  [
    'audio',
    'Tarang',
    'Tarang Soundbar 2.1 (120W)',
    9999,
    14999,
    7,
    ['120W with subwoofer', 'HDMI ARC', 'Wall-mountable'],
  ],
  [
    'fashion',
    'Urbane',
    'Urbane Men Cotton Polo T-Shirt',
    599,
    1299,
    120,
    ['100% cotton', 'Regular fit', 'Machine wash'],
  ],
  ['fashion', 'Urbane', 'Urbane Women Kurta Set', 1499, 2999, 35, ['Rayon blend', 'Straight fit', 'With dupatta']],
  ['fashion', 'Stride', 'Stride Running Shoes', 2499, 4499, 50, ['Breathable mesh', 'Cushioned sole', 'Lightweight']],
  ['fashion', 'Stride', 'Stride Casual Sneakers', 1899, 3499, 0, ['Canvas upper', 'Rubber sole', 'Lace-up']],
  ['fashion', 'Ziva', 'Ziva Women Handbag', 1299, 2799, 22, ['Faux leather', 'Multiple pockets', 'Detachable strap']],
  ['fashion', 'Ziva', 'Ziva Analog Watch', 2199, 3999, 16, ['Stainless steel', 'Water resistant', '2-year warranty']],
  ['fashion', 'Urbane', 'Urbane Men Slim Fit Jeans', 1199, 2499, 64, ['Stretch denim', 'Slim fit', 'Mid rise']],
  [
    'home-kitchen',
    'Rasoi',
    'Rasoi Non-Stick Cookware Set (3 pcs)',
    1799,
    3299,
    28,
    ['Induction compatible', 'PFOA-free', 'Soft-touch handles'],
  ],
  ['home-kitchen', 'Rasoi', 'Rasoi Mixer Grinder 750W', 3499, 5499, 19, ['3 jars', '750W motor', '5-year warranty']],
  [
    'home-kitchen',
    'Aura',
    'Aura Air Fryer 4.2L',
    4999,
    8999,
    11,
    ['Uses 85% less oil', 'Digital controls', '8 presets'],
  ],
  ['home-kitchen', 'Aura', 'Aura Robot Vacuum', 14999, 24999, 5, ['App control', 'Auto-charging', 'Mopping mode']],
  [
    'home-kitchen',
    'Griha',
    'Griha Cotton Bedsheet (Double)',
    899,
    1999,
    70,
    ['100% cotton', '2 pillow covers', '180 thread count'],
  ],
  [
    'home-kitchen',
    'Griha',
    'Griha LED Table Lamp',
    799,
    1499,
    33,
    ['3 brightness levels', 'USB powered', 'Flexible neck'],
  ],
  ['home-kitchen', 'Aura', 'Aura Electric Kettle 1.5L', 999, 1799, 0, ['Auto shut-off', 'Stainless steel', '1500W']],
  ['books', 'Pustak Press', 'The Quiet Engineer (Paperback)', 349, 499, 90, ['Fiction', '320 pages', 'English']],
  [
    'books',
    'Pustak Press',
    'Learning to Code with JavaScript',
    599,
    899,
    42,
    ['Beginner friendly', '450 pages', 'Exercises included'],
  ],
  ['books', 'Lekh', 'Monsoon Stories (Hardcover)', 499, 799, 26, ['Short stories', '240 pages', 'Illustrated']],
  ['books', 'Lekh', 'Indian History in 100 Objects', 799, 1199, 13, ['Non-fiction', '400 pages', 'Full colour']],
  ['books', 'Pustak Press', 'Cooking Without Fuss', 399, 650, 0, ['Recipes', '200 pages', 'Vegetarian']],
];

export const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export const ICONS = { mobiles: '📱', laptops: '💻', audio: '🎧', fashion: '👕', 'home-kitchen': '🍳', books: '📚' };

// Placeholder product image: an inline SVG tile with the category icon and a label, tinted per seed.
// Works offline and looks the same every run. Also used for admin-created products without uploaded photos.
export function image(seed, icon, label, view = 0) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const angle = [135, 45, 90][view];
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">
<defs><linearGradient id="g" gradientTransform="rotate(${angle} .5 .5)"><stop offset="0" stop-color="hsl(${hue} 70% 92%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 65% 80%)"/></linearGradient></defs>
<rect width="600" height="600" fill="url(#g)"/>
<text x="300" y="${view === 2 ? 330 : 300}" font-size="${view === 1 ? 260 : 200}" text-anchor="middle" dominant-baseline="middle">${icon}</text>
${label ? `<text x="300" y="520" font-family="system-ui,sans-serif" font-size="44" font-weight="700" fill="hsl(${hue} 45% 28%)" text-anchor="middle">${esc(label)}</text>` : ''}
</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// Deterministic pseudo-random ratings so tests and screenshots are stable.
function ratingFor(i) {
  const avg = Math.round((3.4 + ((i * 37) % 16) / 10) * 10) / 10; // 3.4–4.9
  const count = ((i * 7919) % 2400) + 12;
  return { avg: Math.min(avg, 4.9), count };
}

export async function seedCatalog(db, { force = false } = {}) {
  const products = db.collection('products');
  const categories = db.collection('categories');
  if (!force && (await products.estimatedDocumentCount()) > 0) {
    return { skipped: true };
  }
  if (force) await Promise.all([products.deleteMany({}), categories.deleteMany({})]);

  const { insertedIds } = await categories.insertMany(
    CATEGORIES.map((c, i) => ({ ...c, sortOrder: i, image: image(c.slug, ICONS[c.slug]), createdAt: new Date() })),
  );
  const categoryIds = Object.fromEntries(CATEGORIES.map((c, i) => [c.slug, insertedIds[i]]));

  const start = Date.now() - PRODUCTS.length * 3600_000;
  await products.insertMany(
    PRODUCTS.map(([category, brand, title, price, mrp, stock, highlights], i) => {
      const slug = slugify(title);
      return {
        slug,
        title,
        brand,
        categoryId: categoryIds[category],
        description: `${title} from ${brand}. ${highlights.join('. ')}.`,
        highlights,
        price: price * 100,
        mrp: mrp * 100,
        stock,
        ...(VARIANTS[title] && {
          // One option name, or two (`[['Colour', 'Size'], …]` with each row's values as a list).
          options: [VARIANTS[title][0]].flat(),
          variantName: optionsPhrase([VARIANTS[title][0]].flat()),
          variants: VARIANTS[title][1].map(([value, vPrice, vMrp, vStock, views = []]) => ({
            _id: new ObjectId(),
            values: [value].flat(),
            label: variantLabel([value].flat()),
            price: vPrice * 100,
            mrp: vMrp * 100,
            stock: vStock,
            images: views.map((view) => image(slug, ICONS[category], brand, view)),
          })),
        }),
        images: [0, 1, 2].map((view) => image(slug, ICONS[category], brand, view)),
        rating: ratingFor(i + 1),
        active: true,
        createdAt: new Date(start + i * 3600_000),
        updatedAt: new Date(start + i * 3600_000),
      };
    }),
  );
  return { categories: CATEGORIES.length, products: PRODUCTS.length };
}

// CLI: npm run seed [-- --force]
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.argv.includes('--force');
  const config = loadConfig();
  const { client, db } = await connectDb(config.mongodbUri, config.mongodbDb);
  try {
    if (force) console.warn(`--force: replacing all products and categories in "${config.mongodbDb}".`);
    const result = await seedCatalog(db, { force });
    console.log(
      result.skipped
        ? 'Products already exist; nothing seeded. Use `npm run seed -- --force` to replace them.'
        : `Seeded ${result.categories} categories and ${result.products} products.`,
    );
  } finally {
    await client.close();
  }
}
