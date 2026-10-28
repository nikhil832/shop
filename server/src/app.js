import express from 'express';
import { sessionMiddleware } from './auth.js';
import { couponsRouter } from './coupons.js';
import { accountRouter } from './routes/account.js';
import { authRouter } from './routes/auth.js';
import { catalogRouter } from './routes/catalog.js';
import { dashboardRouter } from './routes/dashboard.js';
import { deliveryRouter } from './routes/delivery.js';
import { orderExportRouter } from './routes/orderExport.js';
import { productImportRouter } from './routes/productImport.js';
import { ordersRouter } from './routes/orders.js';
import { paymentsRouter } from './routes/payments.js';
import { aiWriterRouter } from './routes/aiWriter.js';
import { adminRouter } from './routes/admin.js';
import { activityRouter } from './activity.js';
import { gstSettingsRouter } from './routes/gstSettings.js';
import { imagesRouter } from './routes/images.js';
import { reviewsRouter } from './routes/reviews.js';
import { questionsRouter } from './routes/questions.js';
import { returnsRouter } from './routes/returns.js';
import { stockAlertsRouter } from './routes/stockAlerts.js';
import { wishlistRouter } from './routes/wishlist.js';
import { savedCartRouter } from './routes/savedCart.js';
import { errorReportsRouter } from './routes/errorReports.js';
import { weeklyNoteRouter } from './weeklyNote.js';
import { reviewSummariesRouter } from './reviewSummaries.js';
import { screeningRouter } from './screening.js';
import { smartSearchRouter } from './smartSearch.js';
import { assistantRouter } from './assistant.js';
import { helpRouter } from './routes/help.js';
import { accountDataRouter } from './routes/accountData.js';
import { staffRouter } from './staff.js';
import { salesRouter } from './sales.js';
import { securityHeaders } from './securityHeaders.js';
import { stockHistoryRouter } from './stockHistory.js';
import { announcementsRouter } from './announcements.js';
import { creditRouter } from './credit.js';
import { compareRouter } from './routes/compare.js';
import { customersRouter } from './routes/customers.js';
import { searchInsightsRouter } from './searchInsights.js';
import { giftCardsRouter } from './giftCards.js';
import { codRouter } from './cod.js';
import { stockReceiptsRouter } from './stockReceipts.js';
import { bundlesRouter } from './bundles.js';

// Builds the Express app around an injected database. ctx = { db, client, config, razorpay, mail } (razorpay is null
// when online payments aren't configured; mail sends or logs order emails).
export function createApp(ctx) {
  const app = express();
  app.disable('x-powered-by');
  // When hosted (Render), one HTTPS proxy sits in front: trusting it makes req.secure true, so the session cookie is
  // marked Secure. Locally there is no proxy and nothing changes.
  app.set('trust proxy', 1);
  // On everything, pages and API alike (securityHeaders.js).
  app.use(securityHeaders);
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
  api.use(accountDataRouter(ctx));
  api.use(accountRouter(ctx));
  api.use(ordersRouter(ctx));
  api.use(paymentsRouter(ctx));
  api.use(imagesRouter(ctx));
  api.use(reviewsRouter(ctx));
  api.use(questionsRouter(ctx));
  api.use(returnsRouter(ctx));
  api.use(wishlistRouter(ctx));
  api.use(savedCartRouter(ctx));
  api.use(stockAlertsRouter(ctx));
  api.use(couponsRouter(ctx));
  api.use(dashboardRouter(ctx));
  api.use(deliveryRouter(ctx));
  api.use(activityRouter(ctx));
  api.use(gstSettingsRouter(ctx));
  api.use(errorReportsRouter(ctx));
  api.use(weeklyNoteRouter(ctx));
  api.use(reviewSummariesRouter(ctx));
  api.use(screeningRouter(ctx));
  api.use(smartSearchRouter(ctx));
  api.use(assistantRouter(ctx));
  api.use(helpRouter(ctx));
  api.use(staffRouter(ctx));
  api.use(salesRouter(ctx));
  api.use(stockHistoryRouter(ctx));
  api.use(announcementsRouter(ctx));
  api.use(creditRouter(ctx));
  api.use(compareRouter(ctx));
  api.use(customersRouter(ctx));
  api.use(searchInsightsRouter(ctx));
  api.use(giftCardsRouter(ctx));
  api.use(codRouter(ctx));
  api.use(stockReceiptsRouter(ctx));
  api.use(bundlesRouter(ctx));
  // Before adminRouter, whose /admin/orders/:id and /admin/products/:id would take "export" or "import" for an id.
  api.use(orderExportRouter(ctx));
  api.use(productImportRouter(ctx));
  api.use(aiWriterRouter(ctx));
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
