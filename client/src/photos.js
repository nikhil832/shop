import { upload } from './api.js';

// Customers' photos are shrunk in the browser before uploading: at most 1600 px on the long side, as a JPEG under the
// server's 1 MB limit. Re-drawing the picture also leaves out where and when it was taken (the server strips that
// too). Phones' sideways photos come out the right way up (createImageBitmap applies their orientation).
const MAX_SIDE = 1600;
const MAX_BYTES = 1024 * 1024;

const toBlob = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

export async function shrinkPhoto(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.55]) {
    const blob = await toBlob(canvas, quality);
    if (blob && blob.size <= MAX_BYTES) return blob;
  }
  throw new Error('This photo is too large even after shrinking it');
}

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
