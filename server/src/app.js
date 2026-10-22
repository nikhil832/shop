import express from 'express';
import { sessionMiddleware } from './auth.js';
import { authRouter } from './routes/auth.js';
import { catalogRouter } from './routes/catalog.js';
import { ordersRouter } from './routes/orders.js';
import { paymentsRouter } from './routes/payments.js';
import { adminRouter } from './routes/admin.js';
import { imagesRouter } from './routes/images.js';
import { reviewsRouter } from './routes/reviews.js';
import { wishlistRouter } from './routes/wishlist.js';

// Builds the Express app around an injected database. ctx = { db, client, config, razorpay, mail } (razorpay is null
// when online payments aren't configured; mail sends or logs order emails).
export function createApp(ctx) {
  const app = express();
  app.disable('x-powered-by');
  // When hosted (Render), one HTTPS proxy sits in front: trusting it makes req.secure true, so the session cookie is
  // marked Secure. Locally there is no proxy and nothing changes.
  app.set('trust proxy', 1);
  // The raw body is kept for the Razorpay webhook, whose signature covers the exact bytes sent.
  app.use(express.json({ limit: '100kb', verify: (req, res, buf) => (req.rawBody = buf) }));

  const api = express.Router();
  // For the host's health check: up only while the database answers. Before the session lookup, which it doesn't need.
  api.get('/health', async (req, res) => {
    await ctx.db.command({ ping: 1 });
    res.json({ ok: true });
  });
  api.use(sessionMiddleware(ctx));
  api.use(catalogRouter(ctx));
  api.use(authRouter(ctx));
  api.use(ordersRouter(ctx));
  api.use(paymentsRouter(ctx));
  api.use(imagesRouter(ctx));
  api.use(reviewsRouter(ctx));
  api.use(wishlistRouter(ctx));
  api.use(adminRouter(ctx));
  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    const message = err.type === 'entity.too.large' ? 'File is too large' : err.message;
    res.status(status).json({ error: status >= 500 && !err.expose ? 'Internal server error' : message });
  });

  return app;
}
