/**
 * Popup-side services: typed wrappers around chrome.runtime messaging and the
 * backend REST API. Keeping these out of components makes them unit-testable
 * and lets every screen share one integration surface.
 */

import type {
  AiAnalysis,
  AppSettings,
  BugReport,
  CaptureAndOpenResult,
  RuntimeMessage,
  ScreenshotMode,
} from '../types';
import { redactBody, redactUrl, truncate } from '../utils/redaction';
import { getAuthToken } from './session';

/* ------------------------------------------------------------------ */
/* Background bridge                                                  */
/* ------------------------------------------------------------------ */

function sendMessage<T>(msg: RuntimeMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response as T);
    });
  });
}

export const backgroundService = {
  /** Capture the active tab, snapshot evidence and open the editor tab. */
  async captureAndOpenEditor(mode: ScreenshotMode): Promise<void> {
    const r = await sendMessage<CaptureAndOpenResult>({ kind: 'CAPTURE_AND_OPEN_EDITOR', mode });
    if (!r?.ok) throw new Error(r?.error ?? 'Screenshot capture failed');
  },
};

/* ------------------------------------------------------------------ */
/* Privacy pipeline – apply redaction to everything leaving the popup  */
/* ------------------------------------------------------------------ */

export function sanitizeReport(report: BugReport, enabled: boolean): BugReport {
  if (!enabled) return report;
  return {
    ...report,
    page: { ...report.page, url: redactUrl(report.page.url) },
    consoleEntries: report.consoleEntries.map((c) => ({
      ...c,
      message: redactBody(c.message),
      stack: c.stack ? truncate(redactBody(c.stack), 2000) : undefined,
    })),
    networkEntries: report.networkEntries.map((n) => ({
      ...n,
      url: redactUrl(n.url),
      requestBody: n.requestBody ? truncate(redactBody(n.requestBody)) : undefined,
      responseBody: n.responseBody ? truncate(redactBody(n.responseBody)) : undefined,
    })),
    actions: report.actions.map((a) => ({
      ...a,
      value: a.value ? redactBody(a.value) : undefined,
      label: redactBody(a.label),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Backend API client. The OpenAI API key NEVER lives here.           */
/* ------------------------------------------------------------------ */

export class BackendClient {
  constructor(private baseUrl: string) {}

  private async post(path: string, body: unknown, timeoutMs: number): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = await getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** Health check used by Settings → "Backend connection status". */
  async health(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/api/health`, { signal: AbortSignal.timeout(4000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Ask the backend to run AI analysis over the collected evidence. */
  async analyze(report: BugReport): Promise<AiAnalysis> {
    const r = await this.post('/api/analyze', await toAiPayload(report), 120_000);
    if (!r.ok) {
      const text = await safeText(r);
      throw new Error(`AI analysis failed (${r.status}): ${text}`);
    }
    const json = (await r.json()) as { analysis: AiAnalysis };
    return json.analysis;
  }

  /** Upload screenshot; returns a hosted URL for the Sheets row. */
  async uploadScreenshot(reportId: string, dataUrl: string): Promise<string> {
    const r = await this.post('/api/screenshot', { reportId, image: dataUrl }, 60_000);
    if (!r.ok) throw new Error(`Screenshot upload failed (${r.status}): ${await safeText(r)}`);
    const json = (await r.json()) as { url: string };
    return json.url;
  }

  /** Submit the final row to Google Sheets through the backend. */
  async submitToSheets(
    report: BugReport,
    settings: Pick<AppSettings, 'sheetsSpreadsheetId' | 'sheetsWorksheet'>,
    screenshotUrl?: string,
  ): Promise<{ rowId: string }> {
    const r = await this.post(
      '/api/sheets/submit',
      {
        report: toSheetPayload(report),
        screenshotUrl,
        spreadsheetId: settings.sheetsSpreadsheetId,
        worksheet: settings.sheetsWorksheet,
      },
      30_000,
    );
    if (!r.ok) {
      const text = await safeText(r);
      throw new Error(`Sheets submission failed (${r.status}): ${text}`);
    }
    return (await r.json()) as { rowId: string };
  }
}

async function safeText(r: Response): Promise<string> {
  try {
    return (await r.text()).slice(0, 200);
  } catch {
    return '';
  }
}

/** Trim a report down to what the AI actually needs (keeps payload sane). */
async function toAiPayload(report: BugReport) {
  return {
    reportType: report.form.reportType ?? 'bug',
    testerNote: report.form.additionalNotes,
    page: report.page,
    environment: report.environment,
    form: report.form,
    consoleEntries: report.consoleEntries.slice(-50),
    networkEntries: report.networkEntries.slice(-80),
    actions: report.actions.slice(-50),
    screenshot: report.screenshot
      ? { dataUrl: await prepareImageForAi(report.screenshot.dataUrl), mode: report.screenshot.mode }
      : null,
  };
}

/**
 * GPT-4o downscales large images anyway (and caps uploads at 20MB), so there
 * is no point sending a huge capture. Tall full-page captures are shrunk to fit and sent as
 * JPEG so the request stays small; the stored screenshot is untouched.
 */
async function prepareImageForAi(dataUrl: string): Promise<string> {
  const MAX_SIDE = 7800;
  const MAX_PIXELS = 12_000_000;
  try {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height), Math.sqrt(MAX_PIXELS / (bmp.width * bmp.height)));
    if (scale === 1 && dataUrl.length < 4_000_000) {
      bmp.close();
      return dataUrl;
    }
    const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    for (const quality of [0.85, 0.7, 0.5]) {
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      if (blob.size < 3_700_000) return await blobToDataUrl(blob); // base64 adds ~33%
    }
    return await blobToDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.35 }));
  } catch {
    return dataUrl;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function toSheetPayload(report: BugReport) {
  return {
    id: report.id,
    createdAt: report.createdAt,
    form: report.form,
    ai: report.ai ?? null,
    page: report.page,
    environment: report.environment,
    consoleErrors: report.consoleEntries.filter((c) => c.type === 'error' || c.type === 'exception'),
    apiErrors: report.networkEntries.filter((n) => n.failed || n.status >= 400),
  };
}
