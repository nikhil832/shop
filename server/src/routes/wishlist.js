import express from 'express';
import { requireUser } from '../auth.js';
import { HttpError, parseObjectId } from '../http.js';
import { toProductCard } from './catalog.js';

export const WISHLIST_LIMIT = 200;

// The wishlist is saved in the account: one `wishlist` document per (user, product).
export function wishlistRouter({ db }) {
  const wishlist = db.collection('wishlist');
  const products = db.collection('products');
  const router = express.Router();
  router.use('/wishlist', requireUser);

  // Newest first. Products an admin has since hidden are left out (and come back if shown again).
  router.get('/wishlist', async (req, res) => {
    const docs = await wishlist
      .aggregate([
        { $match: { userId: req.user._id } },
        { $sort: { addedAt: -1, _id: -1 } },
        { $limit: WISHLIST_LIMIT },
        { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'product' } },
        { $unwind: '$product' },
        { $match: { 'product.active': true } },
      ])
      .toArray();
    res.json(docs.map((d) => ({ ...toProductCard(d.product), addedAt: d.addedAt })));
  });

  router.put('/wishlist/:productId', async (req, res) => {
    const productId = parseObjectId(req.params.productId, 'product id');
    if (!(await products.findOne({ _id: productId, active: true }, { projection: { _id: 1 } }))) {
      throw new HttpError(404, 'Product not found');
    }
    const userId = req.user._id;
    if ((await wishlist.countDocuments({ userId })) >= WISHLIST_LIMIT) {
      // Saving one that's already there is fine even when full.
      if (!(await wishlist.findOne({ userId, productId }))) {
        throw new HttpError(409, `Your wishlist is full (${WISHLIST_LIMIT} items). Remove something first`);
      }
    }
    await wishlist.updateOne({ userId, productId }, { $setOnInsert: { addedAt: new Date() } }, { upsert: true });
    res.json({ saved: true });
  });

  router.delete('/wishlist/:productId', async (req, res) => {
    const productId = parseObjectId(req.params.productId, 'product id');
    await wishlist.deleteOne({ userId: req.user._id, productId });
    res.json({ saved: false });
  });

  return router;
}
