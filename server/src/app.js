import express from 'express';
import { sessionMiddleware } from './auth.js';
import { authRouter } from './routes/auth.js';
import { catalogRouter } from './routes/catalog.js';
import { ordersRouter } from './routes/orders.js';
import { adminRouter } from './routes/admin.js';
import { imagesRouter } from './routes/images.js';

// Builds the Express app around an injected database. ctx = { db, client, config }.
export function createApp(ctx) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  api.use(sessionMiddleware(ctx));
  api.use(catalogRouter(ctx));
  api.use(authRouter(ctx));
  api.use(ordersRouter(ctx));
  api.use(imagesRouter(ctx));
  api.use(adminRouter(ctx));
  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    const message = err.type === 'entity.too.large' ? 'File is too large' : err.message;
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : message });
  });

  return app;
}
