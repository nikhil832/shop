import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { request, upload } from '../../api.js';
import { toPaise, toRupees } from '../../format.js';
import { useFetch } from '../../useFetch.js';
import NotFound from '../NotFound.jsx';

const MAX_IMAGES = 5;
const MAX_BYTES = 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// The first image is the one shown on cards. Uploads go up immediately; the product keeps their URLs when saved.
function Images({ images, onChange }) {
  const [state, setState] = useState({ busy: false, error: null });

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
  label: v.label ?? '',
  price: v.price ? toRupees(v.price) : '',
  mrp: v.mrp ? toRupees(v.mrp) : '',
  stock: v.stock ?? 0,
});

// The variants of a product that has them (sizes, colours…), each with its own price, MRP and stock. Rows keep the
// id of an existing variant, so editing doesn't detach it from carts and past orders.
function Variants({ name, rows, onChange }) {
  const set = (key, field, value) => onChange(rows.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  return (
    <fieldset className="variant-editor">
      <legend>Variants</legend>
      <label>
        Option name
        <input name="variantName" required maxLength={20} placeholder="Size, Colour…" defaultValue={name} />
      </label>
      <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Price (₹)</th>
              <th>MRP (₹)</th>
              <th>Stock</th>
              <th>
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key}>
                <td>
                  <input
                    value={r.label}
                    onChange={(e) => set(r.key, 'label', e.target.value)}
                    required
                    maxLength={30}
                    placeholder="UK 8, Blue…"
                    aria-label={`Label of variant ${i + 1}`}
                  />
                </td>
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
      {rows.length < 20 && (
        <button type="button" className="btn small" onClick={() => onChange([...rows, newRow()])}>
          Add a variant
        </button>
      )}
      <span className="muted small">
        The store shows the lowest price (&ldquo;from ₹…&rdquo;) and the total stock. Customers choose one before adding
        to the cart.
      </span>
    </fieldset>
  );
}

function ProductForm({ product, categories }) {
  const navigate = useNavigate();
  const [images, setImages] = useState(product?.images ?? []);
  const [state, setState] = useState({ busy: false, error: null });
  // Variant rows, or null for a product without variants.
  const [variants, setVariants] = useState(product?.variants.length ? product.variants.map(newRow) : null);

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
            variantName: form.get('variantName'),
            variants: variants.map((v) => ({
              ...(v.id && { id: v.id }),
              label: v.label,
              price: toPaise(v.price),
              mrp: toPaise(v.mrp),
              stock: Number(v.stock),
            })),
          }
        : {
            variants: [],
            price: toPaise(form.get('price')),
            mrp: toPaise(form.get('mrp')),
            stock: Number(form.get('stock')),
          }),
      images,
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
    <form className="panel admin-form" onSubmit={submit}>
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
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={Boolean(variants)}
          onChange={(e) => setVariants(e.target.checked ? [newRow()] : null)}
        />
        Comes in sizes, colours or other options, each with its own price and stock
      </label>
      {variants && <Variants name={product?.variantName} rows={variants} onChange={setVariants} />}
      <Images images={images} onChange={setImages} />
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
