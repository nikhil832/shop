import express from 'express';
import { Binary } from 'mongodb';
import { requireAdmin } from '../auth.js';
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

// Product photos uploaded by admins, stored in the `images` collection so nothing depends on an outside service.
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

  return router;
}
