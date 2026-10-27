import { upload } from './api.js';

// Photos are shrunk in the browser before uploading (the server has no image library): customers' review photos and
// admins' product photos to at most 1600 px on the long side, as a JPEG under the server's 1 MB limit, and product
// photos also to a small version for cards and lists (stage 68). Re-drawing the picture also leaves out where and when
// it was taken (the server strips that from review photos too). Phones' sideways photos come out the right way up
// (createImageBitmap applies their orientation), and see-through parts become white rather than JPEG's black.
const FULL = { maxSide: 1600, maxBytes: 1024 * 1024 };
const SMALL = { maxSide: 400, maxBytes: 200 * 1024 };

const toBlob = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

async function shrink(file, { maxSide, maxBytes }) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.55]) {
    const blob = await toBlob(canvas, quality);
    if (blob && blob.size <= maxBytes) return blob;
  }
  throw new Error('This photo is too large even after shrinking it');
}

export const shrinkPhoto = (file) => shrink(file, FULL);

// Shrinks and uploads one photo for a review; returns its address.
export async function uploadReviewPhoto(file) {
  let blob;
  try {
    blob = await shrinkPhoto(file);
  } catch {
    throw new Error(`${file.name} couldn't be read as a photo`);
  }
  return (await upload('/reviews/photos', blob)).url;
}

// Uploads a product photo's small version (`id` is the photo's upload). Failing only costs speed, so it never throws.
export async function uploadSmallVersion(id, fileOrBlob) {
  try {
    await upload(`/admin/images/${id}/small`, await shrink(fileOrBlob, SMALL));
    return true;
  } catch {
    return false;
  }
}

// Shrinks and uploads one product photo with its small version; returns the photo's address.
export async function uploadProductPhoto(file) {
  let blob;
  try {
    blob = await shrinkPhoto(file);
  } catch {
    throw new Error(`${file.name} couldn't be read as a photo`);
  }
  const { id, url } = await upload('/admin/images', blob);
  await uploadSmallVersion(id, blob);
  return url;
}
