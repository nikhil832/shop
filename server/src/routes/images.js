import express from 'express';
import { Binary, ObjectId } from 'mongodb';
import { requireAdmin, requireUser } from '../auth.js';
import { stripMetadata } from '../imageMetadata.js';
import { takeHourlySlot } from '../rateLimit.js';
import { HttpError, parseObjectId } from '../http.js';

export const MAX_IMAGE_BYTES = 1024 * 1024;

// The file must really be the type it claims, checked by its first bytes.
const SIGNATURES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) =>
    b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

export const imageUrl = (id) => `/api/images/${id}`;
// Review photos customers may upload in an hour.
export const REVIEW_PHOTOS_PER_HOUR = 20;
const REVIEW_PHOTO_TYPES = ['image/jpeg', 'image/png'];

// How long an upload is kept before it can count as unused: the admin may still be filling in the product form.
export const UNUSED_IMAGE_GRACE_MS = 24 * 60 * 60 * 1000;
export const UPLOAD_URL = /^\/api\/images\/([0-9a-f]{24})$/;

// Ids of uploads still in use: by a product (shown or hidden), by an order item, which keeps the photo it was bought
// with even after the product's photos change, or by a review (shown or hidden).
async function imagesInUse(db) {
  const referenced = (collection, field) =>
    db
      .collection(collection)
      .aggregate([
        { $project: { url: `$${field}` } },
        { $unwind: '$url' },
        { $match: { url: { $regex: '^/api/images/' } } },
        { $group: { _id: '$url' } },
      ])
      .toArray();
  // Variant photos are always among their product's, but are counted too in case that ever changes.
  const [inProducts, inVariants, inOrders, inReviews] = await Promise.all([
    referenced('products', 'images'),
    db
      .collection('products')
      .aggregate([
        { $unwind: '$variants' },
        { $unwind: '$variants.images' },
        { $match: { 'variants.images': { $regex: '^/api/images/' } } },
        { $group: { _id: '$variants.images' } },
      ])
      .toArray(),
    referenced('orders', 'items.image'),
    referenced('reviews', 'photos'),
  ]);
  return new Set(
    [...inProducts, ...inVariants, ...inOrders, ...inReviews].map((r) => r._id.match(UPLOAD_URL)?.[1]).filter(Boolean),
  );
}

// The uploads among `urls` that no longer exist (deleted as unused), for the product form's check.
export async function missingImages({ db }, urls) {
  const ids = urls.map((u) => u.match(UPLOAD_URL)?.[1]).filter(Boolean);
  if (!ids.length) return [];
  const found = await db
    .collection('images')
    .find({ _id: { $in: ids.map((id) => ObjectId.createFromHexString(id)) } }, { projection: { _id: 1 } })
    .toArray();
  const present = new Set(found.map((img) => img._id.toString()));
  return ids.filter((id) => !present.has(id));
}

// Deletes uploaded photos that nothing refers to, once they're older than the grace period (an hourly sweep in
// index.js; Atlas's free tier holds 512 MB). Returns how many were deleted and their total size in bytes. Saving a
// product checks its uploads still exist (`missingImages`), so a form left open past the sweep can't save a gone photo.
export async function deleteUnusedImages({ db }, { now = new Date() } = {}) {
  const images = db.collection('images');
  const old = await images
    .find({ createdAt: { $lt: new Date(now.getTime() - UNUSED_IMAGE_GRACE_MS) } }, { projection: { size: 1 } })
    .toArray();
  if (!old.length) return { deleted: 0, bytes: 0 };
  const used = await imagesInUse(db);
  const unused = old.filter((img) => !used.has(img._id.toString()));
  if (!unused.length) return { deleted: 0, bytes: 0 };
  const { deletedCount } = await images.deleteMany({ _id: { $in: unused.map((img) => img._id) } });
  const bytes = unused.reduce((sum, img) => sum + (img.size ?? 0), 0);
  return { deleted: deletedCount, bytes };
}

// Product photos uploaded by admins, and customers' review photos, stored in the `images` collection so nothing depends
// on an outside service.
export function imagesRouter({ db }) {
  const images = db.collection('images');
  const router = express.Router();

  router.get('/images/:id', async (req, res) => {
    const doc = await images.findOne({ _id: parseObjectId(req.params.id, 'image id') });
    if (!doc) throw new HttpError(404, 'Image not found');
    // An image never changes once uploaded (edits upload a new one), so browsers may cache it forever.
    res.set({
      'Content-Type': doc.contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(Buffer.from(doc.data.buffer.subarray(0, doc.data.position)));
  });

  // The request body is the file itself, with its Content-Type header.
  router.post(
    '/admin/images',
    requireAdmin,
    express.raw({ type: Object.keys(SIGNATURES), limit: MAX_IMAGE_BYTES }),
    async (req, res) => {
      const type = req.get('Content-Type')?.split(';')[0].trim().toLowerCase();
      if (!Buffer.isBuffer(req.body) || !SIGNATURES[type]) throw new HttpError(400, 'Upload a JPEG, PNG or WebP image');
      if (!SIGNATURES[type](req.body)) {
        throw new HttpError(400, `This file is not a valid ${type.slice(6).toUpperCase()}`);
      }
      const { insertedId } = await images.insertOne({
        data: new Binary(req.body),
        contentType: type,
        size: req.body.length,
        uploadedBy: req.user._id,
        createdAt: new Date(),
      });
      res.status(201).json({ id: insertedId.toString(), url: imageUrl(insertedId) });
    },
  );

  // A customer's photo for their review: JPEG or PNG, with where and when it was taken removed (imageMetadata.js). It
  // only appears once a review uses it (routes/reviews.js); unused ones go after a day like admin uploads.
  router.post(
    '/reviews/photos',
    requireUser,
    express.raw({ type: REVIEW_PHOTO_TYPES, limit: MAX_IMAGE_BYTES }),
    async (req, res) => {
      const type = req.get('Content-Type')?.split(';')[0].trim().toLowerCase();
      if (!Buffer.isBuffer(req.body) || !REVIEW_PHOTO_TYPES.includes(type)) {
        throw new HttpError(400, 'Upload a JPEG or PNG photo');
      }
      let data;
      try {
        if (!SIGNATURES[type](req.body)) throw new Error('signature');
        data = stripMetadata(type, req.body);
      } catch {
        throw new HttpError(400, `This file is not a valid ${type.slice(6).toUpperCase()}`);
      }
      if (!(await takeHourlySlot(db, `reviewPhoto:${req.user._id}`, REVIEW_PHOTOS_PER_HOUR))) {
        throw new HttpError(429, 'Too many photos this hour. Please try again later.');
      }
      const { insertedId } = await images.insertOne({
        data: new Binary(data),
        contentType: type,
        size: data.length,
        uploadedBy: req.user._id,
        kind: 'review',
        createdAt: new Date(),
      });
      res.status(201).json({ id: insertedId.toString(), url: imageUrl(insertedId) });
    },
  );

  return router;
}
