import { createHash } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { clientIp, hashToken, networkOf, requireAdmin } from '../auth.js';
import { HttpError, parse, parseObjectId } from '../http.js';
import { logActivity } from '../activity.js';
import { takeHourlySlot } from '../rateLimit.js';
import { placesFor } from '../codeIndex.js';
import { AI_DRAFTS_PER_HOUR } from './aiWriter.js';

// Error reports from visitors' browsers (collection `errorReports`): when a page fails to load or crashes, the client
// posts what happened, and admins see one entry per problem with how often it happened. Reports of the same problem
// (kind, message and the top line of the stack) are counted on one document:
// { key, kind: 'load' | 'crash', message, stack, componentStack, count, firstAt, lastAt, paths (≤10, newest last),
//   browser (the latest user agent), fixedAt: Date | null, explanation?: { explanation, whereToLook, urgent, at, model } }
// A report after an admin marked the problem fixed opens it again. Entries go REPORT_DAYS after their last report.

export const REPORT_DAYS = 90;
export const REPORTS_PER_HOUR = 30; // per visitor network: a page stuck in a crash loop can't flood the list
export const MAX_REPORTS = 500; // different problems kept; reports of a new one past that are dropped
const MAX_PATHS = 10;
const ADMIN_PAGE = 25;

// Long text is cut rather than refused: a report is still worth having with a shortened stack.
const text = (max) =>
  z
    .string()
    .max(20_000)
    .transform((s) => s.slice(0, max));
const reportBody = z.object({
  kind: z.enum(['load', 'crash']),
  message: text(500).pipe(z.string().trim().min(1, 'Say what went wrong')),
  stack: text(4000).optional(),
  componentStack: text(4000).optional(),
  // The page's path and query; anything after # is dropped (reset and email links carry their token there).
  path: text(500)
    .transform((s) => s.split('#')[0])
    .pipe(z.string().startsWith('/', 'A path within the store')),
});
const adminQuery = z.object({
  status: z.enum(['open', 'fixed']).default('open'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
const fixedBody = z.object({ fixed: z.boolean() });

// For the dashboard's "needs attention".
export const OPEN_REPORTS = { fixedAt: null };

// The first line of a stack that names a place in the code: Chrome's "at fn (file:1:2)", Firefox and Safari's
// "fn@file:1:2". Stacks start with the message in Chrome, so the first line alone wouldn't tell problems apart.
function topFrame(stack = '') {
  return (
    stack
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /^at |@/.test(l)) ?? ''
  );
}
export const reportKey = ({ kind, message, stack }) =>
  createHash('sha256')
    .update(`${kind}\n${message}\n${topFrame(stack)}`)
    .digest('base64url');

const toReport = (doc) => ({
  id: doc._id.toString(),
  kind: doc.kind,
  message: doc.message,
  stack: doc.stack ?? null,
  componentStack: doc.componentStack ?? null,
  count: doc.count,
  firstAt: doc.firstAt,
  lastAt: doc.lastAt,
  paths: doc.paths,
  browser: doc.browser,
  fixedAt: doc.fixedAt,
  explanation: doc.explanation ?? null,
});

export function errorReportsRouter(ctx) {
  const { db, config, ai } = ctx;
  const reports = db.collection('errorReports');
  const router = express.Router();

  // From any visitor, logged in or not. 204 also when a new problem is dropped because the list is full.
  router.post('/error-reports', async (req, res) => {
    const report = parse(reportBody, req.body);
    const network = networkOf(clientIp(req, config));
    if (!(await takeHourlySlot(db, `errorReport:${hashToken(network)}`, REPORTS_PER_HOUR))) {
      throw new HttpError(429, 'Too many error reports from this network; try again later');
    }
    const key = reportKey(report);
    if (!(await reports.findOne({ key }, { projection: { _id: 1 } }))) {
      if ((await reports.estimatedDocumentCount()) >= MAX_REPORTS) return res.status(204).end();
    }
    const now = new Date();
    // $literal around everything the browser sent: a value starting with $ would otherwise be read as a field path.
    const path = { $literal: report.path };
    await reports.updateOne(
      { key },
      [
        {
          $set: {
            kind: report.kind,
            message: { $literal: report.message },
            // The first report's stacks; later ones of the same problem only count.
            stack: { $ifNull: ['$stack', { $literal: report.stack ?? null }] },
            componentStack: { $ifNull: ['$componentStack', { $literal: report.componentStack ?? null }] },
            count: { $add: [{ $ifNull: ['$count', 0] }, 1] },
            firstAt: { $ifNull: ['$firstAt', now] },
            lastAt: now,
            paths: {
              $let: {
                vars: { paths: { $ifNull: ['$paths', []] } },
                in: {
                  $cond: [
                    { $in: [path, '$$paths'] },
                    '$$paths',
                    { $slice: [{ $concatArrays: ['$$paths', [path]] }, -MAX_PATHS] },
                  ],
                },
              },
            },
            browser: { $literal: (req.get('user-agent') ?? '').slice(0, 300) },
            fixedAt: null,
          },
        },
      ],
      { upsert: true },
    );
    res.status(204).end();
  });

  router.use('/admin/error-reports', requireAdmin);

  // Open (or fixed) problems, latest report first, with a count of each.
  router.get('/admin/error-reports', async (req, res) => {
    const { status, page } = parse(adminQuery, req.query);
    const filters = { open: OPEN_REPORTS, fixed: { fixedAt: { $ne: null } } };
    const [docs, total, open, fixed] = await Promise.all([
      reports
        .find(filters[status])
        .sort({ lastAt: -1, _id: -1 })
        .skip((page - 1) * ADMIN_PAGE)
        .limit(ADMIN_PAGE)
        .toArray(),
      reports.countDocuments(filters[status]),
      reports.countDocuments(filters.open),
      reports.countDocuments(filters.fixed),
    ]);
    res.json({ items: docs.map(toReport), total, page, pageSize: ADMIN_PAGE, counts: { open, fixed } });
  });

  // "Explain this error" (stage 57): Claude explains the problem in plain words and says where to look, from the report
  // and where the names in it are defined. Kept on the report, so looking again costs nothing; asking again replaces
  // it. Shares the writing assistant's hourly allowance.
  router.post('/admin/error-reports/:id/explain', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'report id');
    if (!ai) {
      throw new HttpError(503, 'The writing assistant is off: the server has no ANTHROPIC_API_KEY.', { expose: true });
    }
    const report = await reports.findOne({ _id });
    if (!report) throw new HttpError(404, 'Report not found');
    if (!(await takeHourlySlot(db, `aiDraft:${req.user._id}`, AI_DRAFTS_PER_HOUR))) {
      throw new HttpError(
        429,
        `You can ask the writing assistant ${AI_DRAFTS_PER_HOUR} times an hour. Try again later.`,
      );
    }
    const result = await ai.explainError(report, await placesFor(report));
    const after = await reports.findOneAndUpdate(
      { _id },
      { $set: { explanation: { ...result, at: new Date(), model: ai.model } } },
      { returnDocument: 'after' },
    );
    if (!after) throw new HttpError(404, 'Report not found');
    res.json(toReport(after));
  });

  // Marks a problem fixed, or open again. Only a real change is logged.
  router.post('/admin/error-reports/:id/fixed', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'report id');
    const { fixed } = parse(fixedBody, req.body);
    const before = await reports.findOneAndUpdate(
      { _id },
      { $set: { fixedAt: fixed ? new Date() : null } },
      { returnDocument: 'before' },
    );
    if (!before) throw new HttpError(404, 'Report not found');
    if (Boolean(before.fixedAt) !== fixed) {
      await logActivity(db, req.user, {
        area: 'errors',
        action: fixed ? 'Marked error fixed' : 'Reopened error',
        target: {
          label: `“${before.message.length > 80 ? `${before.message.slice(0, 79)}…` : before.message}”`,
          path: `/admin/errors${fixed ? '?status=fixed' : ''}`,
        },
      });
    }
    res.json(toReport(await reports.findOne({ _id })));
  });

  return router;
}
