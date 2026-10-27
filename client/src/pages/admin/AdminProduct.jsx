import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { request, upload } from '../../api.js';
import { toPaise, toRupees } from '../../format.js';
import { useFetch } from '../../useFetch.js';
import NotFound from '../NotFound.jsx';

const MAX_IMAGES = 5;
const MAX_BYTES = 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// A description of an uploaded photo for people using screen readers (stage 59), with "Suggest", where Claude looks at
// the photo (only when the server has an API key). Saved with the product.
function PhotoDescription({ src, n, value, onChange, getTitle, ai }) {
  const [state, setState] = useState({ busy: false, error: null });

  async function suggest() {
    if (value.trim() && !window.confirm('Replace this description with a suggestion?')) return;
    setState({ busy: true, error: null });
    try {
      const { alt } = await request('/admin/ai/alt-text', { method: 'POST', body: { image: src, title: getTitle() } });
      onChange(alt);
      setState({ busy: false, error: null });
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <div className="photo-description">
      <label>
        <span>
          Description<span className="sr-only"> of image {n}</span>
        </span>
        <input value={value} maxLength={150} placeholder="What it shows" onChange={(e) => onChange(e.target.value)} />
      </label>
      {ai?.enabled && (
        <button type="button" className="link" onClick={suggest} disabled={state.busy}>
          {state.busy ? 'Looking…' : 'Suggest'}
          <span className="sr-only"> a description of image {n}</span>
        </button>
      )}
      {state.error && (
        <p className="error small" role="alert">
          {state.error}
        </p>
      )}
    </div>
  );
}

// The first image is the one shown on cards. Uploads go up immediately; the product keeps their URLs when saved, with
// the descriptions (`alts`, by address) of the uploaded ones.
function Images({ images, onChange, alts, onAlts, getTitle }) {
  const [state, setState] = useState({ busy: false, error: null });
  const { data: ai } = useFetch('/admin/ai');

  async function add(e) {
    const files = [...e.currentTarget.files];
    e.currentTarget.value = '';
    const room = MAX_IMAGES - images.length;
    const bad = files.find((f) => !TYPES.includes(f.type) || f.size > MAX_BYTES);
    if (bad) return setState({ busy: false, error: `${bad.name}: use a JPEG, PNG or WebP of at most 1 MB` });
    if (files.length > room) return setState({ busy: false, error: `You can add ${room} more image(s)` });
    setState({ busy: true, error: null });
    try {
      const urls = [];
      for (const file of files) urls.push((await upload('/admin/images', file)).url);
      onChange([...images, ...urls]);
      setState({ busy: false, error: null });
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  const move = (i, to) => {
    const next = [...images];
    const [img] = next.splice(i, 1);
    next.splice(to, 0, img);
    onChange(next);
  };

  return (
    <fieldset className="image-editor">
      <legend>Images</legend>
      <ul>
        {images.map((src, i) => (
          <li key={src}>
            <img src={src} alt={`Image ${i + 1}`} width="96" height="96" />
            {i === 0 ? (
              <span className="muted small">Main image</span>
            ) : (
              <button type="button" className="link" onClick={() => move(i, 0)}>
                Make main
              </button>
            )}
            <button type="button" className="link danger" onClick={() => onChange(images.filter((x) => x !== src))}>
              Remove<span className="sr-only"> image {i + 1}</span>
            </button>
            {src.startsWith('/api/images/') && (
              <PhotoDescription
                src={src}
                n={i + 1}
                value={alts[src] ?? ''}
                onChange={(text) => onAlts({ ...alts, [src]: text })}
                getTitle={getTitle}
                ai={ai}
              />
            )}
          </li>
        ))}
      </ul>
      {images.length < MAX_IMAGES && (
        <label className="btn small upload">
          {state.busy ? 'Uploading…' : 'Upload images'}
          <input type="file" accept={TYPES.join(',')} multiple onChange={add} disabled={state.busy} />
        </label>
      )}
      <span className="muted small">
        JPEG, PNG or WebP, up to 1 MB each, at most {MAX_IMAGES}. With none, a placeholder is generated.
      </span>
      {state.error && (
        <p className="error small" role="alert">
          {state.error}
        </p>
      )}
    </fieldset>
  );
}

let nextRow = 0;
const newRow = (v = {}) => ({
  key: nextRow++,
  id: v.id,
  // One value per option, in order (one option: just the label).
  values: v.values ?? (v.label ? [v.label] : []),
  price: v.price ? toRupees(v.price) : '',
  mrp: v.mrp ? toRupees(v.mrp) : '',
  stock: v.stock ?? 0,
  images: v.images ?? [],
});
const MAX_VARIANTS = 40;

// The variants of a product that has them, for one or two options (`names`, e.g. Colour and Size): each row is one
// value per option (one combination) with its own price, MRP and stock. Rows keep the id of an existing variant, so
// editing doesn't detach it from carts and past orders. `photos` are the product's images: each variant can show some
// of them (none ticked means all).
function Variants({ names, onNames, rows, photos, onChange }) {
  const set = (key, field, value) => onChange(rows.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  const setValue = (r, k, value) => {
    const values = [...r.values];
    values[k] = value;
    set(r.key, 'values', values);
  };
  const togglePhoto = (r, src) =>
    set(r.key, 'images', r.images.includes(src) ? r.images.filter((x) => x !== src) : [...r.images, src]);
  const columnName = (k) => names[k] || `Option ${k + 1}`;

  // With two options: a row for every pair of values already used that isn't listed yet (stock 0, the first row's
  // prices, and the photos of the first row in the same first value), so the grid needn't be typed in full.
  function addCombinations() {
    const used = (k) => [...new Set(rows.map((r) => r.values[k]?.trim()).filter(Boolean))];
    const has = new Set(rows.map((r) => `${r.values[0]?.trim()}\u0000${r.values[1]?.trim()}`));
    const added = [];
    for (const a of used(0)) {
      for (const b of used(1)) {
        if (has.has(`${a}\u0000${b}`)) continue;
        const like = rows.find((r) => r.values[0]?.trim() === a) ?? rows[0];
        added.push({ ...newRow(), values: [a, b], price: rows[0].price, mrp: rows[0].mrp, images: like.images });
      }
    }
    onChange([...rows, ...added].slice(0, MAX_VARIANTS));
  }

  return (
    <fieldset className="variant-editor">
      <legend>Variants</legend>
      <div className="variant-names">
        {names.map((name, k) => (
          <label key={k}>
            {k === 0 ? 'Option name' : 'Second option'}
            <input
              value={name}
              onChange={(e) => onNames(names.map((n, x) => (x === k ? e.target.value : n)))}
              required
              maxLength={20}
              placeholder={k === 0 ? 'Size, Colour…' : 'e.g. Size'}
            />
          </label>
        ))}
        {names.length === 1 ? (
          <button type="button" className="btn small" onClick={() => onNames([...names, ''])}>
            Add a second option
          </button>
        ) : (
          <button
            type="button"
            className="link danger"
            onClick={() => {
              onNames(names.slice(0, 1));
              onChange(rows.map((r) => ({ ...r, values: r.values.slice(0, 1) })));
            }}
          >
            Remove the second option
          </button>
        )}
      </div>
      <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              {names.map((_, k) => (
                <th key={k}>{names.length > 1 ? columnName(k) : 'Label'}</th>
              ))}
              <th>Price (₹)</th>
              <th>MRP (₹)</th>
              <th>Stock</th>
              {photos.length > 0 && <th>Photos</th>}
              <th>
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key}>
                {names.map((_, k) => (
                  <td key={k}>
                    <input
                      value={r.values[k] ?? ''}
                      onChange={(e) => setValue(r, k, e.target.value)}
                      required
                      maxLength={30}
                      placeholder={k === 0 ? 'UK 8, Blue…' : ''}
                      aria-label={`${names.length > 1 ? columnName(k) : 'Label'} of variant ${i + 1}`}
                    />
                  </td>
                ))}
                <td>
                  <input
                    type="number"
                    min="1"
                    step="0.01"
                    required
                    value={r.price}
                    onChange={(e) => set(r.key, 'price', e.target.value)}
                    aria-label={`Price of variant ${i + 1}`}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="1"
                    step="0.01"
                    required
                    value={r.mrp}
                    onChange={(e) => set(r.key, 'mrp', e.target.value)}
                    aria-label={`MRP of variant ${i + 1}`}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    max="100000"
                    step="1"
                    required
                    value={r.stock}
                    onChange={(e) => set(r.key, 'stock', e.target.value)}
                    aria-label={`Stock of variant ${i + 1}`}
                  />
                </td>
                {photos.length > 0 && (
                  <td>
                    <div className="variant-photos">
                      {photos.map((src, n) => (
                        <label key={src} title={`Photo ${n + 1}`}>
                          <input
                            type="checkbox"
                            checked={r.images.includes(src)}
                            onChange={() => togglePhoto(r, src)}
                            aria-label={`Photo ${n + 1} for variant ${i + 1}`}
                          />
                          <img src={src} alt="" width="40" height="40" />
                        </label>
                      ))}
                    </div>
                  </td>
                )}
                <td>
                  <button
                    type="button"
                    className="link danger"
                    onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
                    disabled={rows.length === 1}
                  >
                    Remove<span className="sr-only"> variant {i + 1}</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="form-actions">
        {rows.length < MAX_VARIANTS && (
          <button type="button" className="btn small" onClick={() => onChange([...rows, newRow()])}>
            Add a variant
          </button>
        )}
        {names.length > 1 && rows.length < MAX_VARIANTS && (
          <button type="button" className="btn small" onClick={addCombinations}>
            Add missing combinations
          </button>
        )}
      </div>
      <span className="muted small">
        The store shows the lowest price (&ldquo;from ₹…&rdquo;) and the total stock. Customers choose one before adding
        to the cart. With two options, each row is one combination (e.g. Black, 32); leave out ones you don&rsquo;t
        sell. Tick a variant&rsquo;s photos to show only those when it&rsquo;s chosen; with none ticked, all are shown.
      </span>
    </fieldset>
  );
}

// "Write for me" (stage 51): Claude drafts the description and highlights from the title, brand, category, the
// highlights typed so far (as facts) and the first uploaded photo; the admin edits them before saving. Shown only when
// the server has an API key, since each draft costs a little.
function WriteForMe({ formRef, images }) {
  const { data: ai } = useFetch('/admin/ai');
  const [state, setState] = useState({ busy: false, error: null, done: false });
  if (!ai?.enabled) return null;

  async function write() {
    const field = (name) => formRef.current.elements.namedItem(name);
    if (field('description').value.trim() && !window.confirm('Replace the description and highlights with a draft?')) {
      return;
    }
    const photo = images.find((src) => src.startsWith('/api/images/'));
    setState({ busy: true, error: null, done: false });
    try {
      const draft = await request('/admin/ai/product-draft', {
        method: 'POST',
        body: {
          title: field('title').value,
          brand: field('brand').value,
          categoryId: field('categoryId').value,
          facts: field('highlights')
            .value.split('\n')
            .map((h) => h.trim())
            .filter(Boolean),
          ...(photo && { image: photo }),
        },
      });
      field('highlights').value = draft.highlights.join('\n');
      field('description').value = draft.description;
      setState({ busy: false, error: null, done: true });
    } catch (err) {
      setState({ busy: false, error: err.message, done: false });
    }
  }

  return (
    <div className="wide write-for-me">
      <button type="button" className="btn small" onClick={write} disabled={state.busy}>
        {state.busy ? 'Writing…' : 'Write for me'}
      </button>
      <p className="muted small" aria-live="polite">
        {state.done
          ? 'Draft written. Check every detail before saving: it can get things wrong.'
          : 'Drafts the description and highlights from the title, brand, category, the highlights above and the first photo.'}
      </p>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
    </div>
  );
}

function ProductForm({ product, categories }) {
  const navigate = useNavigate();
  const formRef = useRef(null);
  const [images, setImages] = useState(product?.images ?? []);
  const [alts, setAlts] = useState(product?.imageAlts ?? {});
  const [state, setState] = useState({ busy: false, error: null });
  // Variant rows, or null for a product without variants, and the names of their one or two options.
  const [variants, setVariants] = useState(product?.variants.length ? product.variants.map(newRow) : null);
  const [optionNames, setOptionNames] = useState(product?.options?.length ? product.options : ['']);

  async function submit(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body = {
      title: form.get('title'),
      brand: form.get('brand'),
      categoryId: form.get('categoryId'),
      description: form.get('description'),
      highlights: form
        .get('highlights')
        .split('\n')
        .map((h) => h.trim())
        .filter(Boolean),
      // With variants their prices and stock are sent; without, the product's own (and `variants: []` switches
      // them off).
      ...(variants
        ? {
            options: optionNames.map((n) => n.trim()),
            variants: variants.map((v) => ({
              ...(v.id && { id: v.id }),
              values: optionNames.map((_, k) => (v.values[k] ?? '').trim()),
              price: toPaise(v.price),
              mrp: toPaise(v.mrp),
              stock: Number(v.stock),
              // Only photos the product still has, in the product's order.
              images: images.filter((src) => v.images.includes(src)),
            })),
          }
        : {
            variants: [],
            price: toPaise(form.get('price')),
            mrp: toPaise(form.get('mrp')),
            stock: Number(form.get('stock')),
          }),
      images,
      // Descriptions of the uploaded photos the product keeps (the server drops empty ones).
      imageAlts: Object.fromEntries(
        images.filter((src) => src.startsWith('/api/images/')).map((src) => [src, (alts[src] ?? '').trim()]),
      ),
      active: form.get('active') === 'on',
    };
    setState({ busy: true, error: null });
    try {
      const saved = product
        ? await request(`/admin/products/${product.id}`, { method: 'PATCH', body })
        : await request('/admin/products', { method: 'POST', body });
      navigate('/admin/products', { state: { saved: saved.title } });
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <form className="panel admin-form" onSubmit={submit} ref={formRef}>
      <div className="admin-head">
        <h1>{product ? 'Edit product' : 'Add product'}</h1>
        {product && (
          <Link to={`/p/${product.slug}`} target="_blank" rel="noreferrer">
            View in store ↗
          </Link>
        )}
      </div>
      <div className="address-grid">
        <label className="wide">
          Title
          <input name="title" required maxLength={150} defaultValue={product?.title} />
        </label>
        <label>
          Brand
          <input name="brand" required maxLength={60} defaultValue={product?.brand} />
        </label>
        <label>
          Category
          <select name="categoryId" required defaultValue={product?.categoryId ?? ''}>
            <option value="" disabled>
              Choose…
            </option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {!variants && (
          <>
            <label>
              Price (₹)
              <input
                name="price"
                type="number"
                min="1"
                step="0.01"
                required
                defaultValue={product && toRupees(product.price)}
              />
            </label>
            <label>
              MRP (₹)
              <input
                name="mrp"
                type="number"
                min="1"
                step="0.01"
                required
                defaultValue={product && toRupees(product.mrp)}
              />
            </label>
            <label>
              Stock
              <input
                name="stock"
                type="number"
                min="0"
                max="100000"
                step="1"
                required
                defaultValue={product?.stock ?? 0}
              />
            </label>
          </>
        )}
        <label className="check">
          <input name="active" type="checkbox" defaultChecked={product?.active ?? true} />
          Show in store
        </label>
        <label className="wide">
          Highlights (one per line, up to 8)
          <textarea name="highlights" rows="3" defaultValue={product?.highlights.join('\n')} />
        </label>
        <label className="wide">
          Description
          <textarea name="description" rows="5" maxLength={5000} defaultValue={product?.description} />
        </label>
        <WriteForMe formRef={formRef} images={images} />
      </div>
      <Images
        images={images}
        onChange={setImages}
        alts={alts}
        onAlts={setAlts}
        getTitle={() => formRef.current?.elements.namedItem('title').value ?? ''}
      />
      <label className="check">
        <input
          type="checkbox"
          checked={Boolean(variants)}
          onChange={(e) => setVariants(e.target.checked ? [newRow()] : null)}
        />
        Comes in sizes, colours or other options, each with its own price and stock
      </label>
      {variants && (
        <Variants names={optionNames} onNames={setOptionNames} rows={variants} photos={images} onChange={setVariants} />
      )}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={state.busy}>
          {product ? 'Save changes' : 'Add product'}
        </button>
        <Link to="/admin/products" className="btn">
          Cancel
        </Link>
      </div>
    </form>
  );
}

export default function AdminProduct() {
  const { id } = useParams();
  const isNew = id === undefined;
  const { data: categories, error: categoriesError } = useFetch('/admin/categories');
  const { data: product, error } = useFetch(isNew ? null : `/admin/products/${encodeURIComponent(id)}`);

  if (error?.status === 404 || error?.status === 400) return <NotFound message="We couldn't find that product." />;
  if (error || categoriesError) return <p className="error">{(error ?? categoriesError).message}</p>;
  if (!categories || (!isNew && !product)) return <p className="muted">Loading…</p>;
  // Keyed so switching between products starts a fresh form.
  return <ProductForm key={product?.id ?? 'new'} product={isNew ? null : product} categories={categories} />;
}
