/**
 * QA Reporter backend.
 *
 *   GET  /api/health
 *   POST /api/auth/session            → anonymous reporter token for the extension
 *   GET  /api/auth/google/login       → Google consent screen
 *   GET  /api/auth/google/callback
 *   GET  /api/auth/me | POST /api/auth/google/logout
 *   POST /api/analyze                 → Claude report draft
 *   POST /api/screenshot              → upload to Drive, returns link
 *   GET  /api/sheets/list | /api/sheets/worksheets
 *   POST /api/sheets/submit           → append a row
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { config } from './config.js';
import { AiRefusalError, AnalyzeRequestSchema, analyzeReport } from './ai.js';
import * as google from './google.js';
import { createSession, isValidSession } from './store.js';
import { reportToRow, SubmitRequestSchema } from './report.js';

const app = express();
app.disable('x-powered-by');

app.use(
  cors({
    origin(origin, cb) {
      // Extension pages send chrome-extension://<id>; curl/health checks send none.
      if (!origin) return cb(null, true);
      const m = origin.match(/^chrome-extension:\/\/([a-p]{32})$/);
      const ok = !!m && (config.allowedExtensionIds.length === 0 || config.allowedExtensionIds.includes(m[1]));
      cb(null, ok); // disallowed origins just get no CORS headers
    },
  }),
);
app.use(express.json({ limit: '25mb' })); // full-page screenshots are large

/** Bearer token issued by /api/auth/session. */
function requireSession(req: Request, res: Response, next: NextFunction): void {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (token && isValidSession(token)) return next();
  res.status(401).json({ error: 'Missing or invalid session token' });
}

const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

/* ---------------- health + auth ---------------- */

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: config.claudeModel, google: google.connectedEmail() !== null });
});

app.post('/api/auth/session', (req, res) => {
  const client = typeof req.body?.client === 'string' ? req.body.client.slice(0, 64) : 'unknown';
  res.json({ token: createSession(client) });
});

app.get('/api/auth/google/login', (_req, res) => {
  res.redirect(google.authUrl());
});

app.get(
  '/api/auth/google/callback',
  asyncRoute(async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) return res.status(400).send(page('Google sign-in was cancelled.'));
    const email = await google.handleCallback(code);
    return res.send(page(`Connected ${email ?? 'your Google account'}. You can close this tab and go back to QA Reporter.`));
  }),
);

app.get('/api/auth/me', requireSession, (_req, res) => {
  res.json({ email: google.connectedEmail() });
});

app.post('/api/auth/google/logout', requireSession, (_req, res) => {
  google.disconnect();
  res.json({ ok: true });
});

/* ---------------- AI ---------------- */

app.post(
  '/api/analyze',
  requireSession,
  asyncRoute(async (req, res) => {
    const body = AnalyzeRequestSchema.parse(req.body);
    const analysis = await analyzeReport(body);
    res.json({ analysis });
  }),
);

/* ---------------- Google ---------------- */

app.post(
  '/api/screenshot',
  requireSession,
  asyncRoute(async (req, res) => {
    const { reportId, image } = z.object({ reportId: z.string().max(64), image: z.string() }).parse(req.body);
    res.json({ url: await google.uploadScreenshot(reportId, image) });
  }),
);

app.get(
  '/api/sheets/list',
  requireSession,
  asyncRoute(async (_req, res) => {
    res.json({ sheets: await google.listSpreadsheets() });
  }),
);

app.get(
  '/api/sheets/worksheets',
  requireSession,
  asyncRoute(async (req, res) => {
    const id = z.string().min(1).parse(req.query.spreadsheetId);
    res.json({ worksheets: await google.listWorksheets(id) });
  }),
);

app.post(
  '/api/sheets/submit',
  requireSession,
  asyncRoute(async (req, res) => {
    const body = SubmitRequestSchema.parse(req.body);
    const rowId = await google.appendRow(body.spreadsheetId, body.worksheet, reportToRow(body.report, body.screenshotUrl));
    res.json({ rowId });
  }),
);

/* ---------------- errors ---------------- */

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid request', issues: err.issues });
  if (err instanceof google.NotConnectedError) return res.status(401).json({ error: err.message });
  if (err instanceof AiRefusalError) return res.status(422).json({ error: err.message });
  if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: 'AI rate limited, retry shortly' });
  if (err instanceof Anthropic.APIError) {
    console.error('[claude]', err.status, err.message);
    return res.status(502).json({ error: `AI request failed (${err.status ?? 'network'})` });
  }
  const gStatus = (err as { code?: number; status?: number })?.status ?? (err as { code?: number })?.code;
  if (typeof gStatus === 'number' && gStatus >= 400 && gStatus < 600) {
    console.error('[google]', gStatus, (err as Error).message);
    return res.status(gStatus === 401 || gStatus === 403 ? 403 : 502).json({ error: `Google: ${(err as Error).message}` });
  }
  console.error(err);
  return res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
});

function page(message: string): string {
  const safe = message.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>QA Reporter</title><body style="font-family:system-ui;padding:40px;max-width:520px;margin:auto"><h2>QA Reporter</h2><p>${safe}</p></body>`;
}

app.listen(config.port, () => {
  console.log(`QA Reporter backend on ${config.publicUrl} (model ${config.claudeModel})`);
});
