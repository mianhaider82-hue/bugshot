/**
 * Popup-side services: typed wrappers around chrome.runtime messaging and the
 * backend REST API. Keeping these out of components makes them unit-testable
 * and lets every screen share one integration surface.
 */

import type {
  AiAnalysis,
  BugReport,
  ConsoleEntry,
  EnvironmentInfo,
  NetworkEntry,
  PageInfo,
  ScreenshotData,
  ScreenshotMode,
  TrackedAction,
} from '../types';
import { redactBody, redactUrl, truncate } from '../utils/redaction';

/* ------------------------------------------------------------------ */
/* Messaging helper                                                   */
/* ------------------------------------------------------------------ */

function sendMessage<T>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response as T);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Background bridge                                                  */
/* ------------------------------------------------------------------ */

interface CaptureResponse {
  ok: boolean;
  dataUrl?: string;
  width?: number;
  height?: number;
  mode?: ScreenshotMode;
  error?: string;
}

export interface EvidenceSnapshot {
  consoleEntries: ConsoleEntry[];
  networkEntries: NetworkEntry[];
  actions: TrackedAction[];
  pageInfo: PageInfo | null;
}

export const backgroundService = {
  startSession(sessionId: string): Promise<{ ok: boolean; tabId: number | null; networkCapturing: boolean }> {
    return sendMessage({ kind: 'START_SESSION', sessionId });
  },
  endSession(sessionId: string): Promise<{ ok: boolean }> {
    return sendMessage({ kind: 'END_SESSION', sessionId });
  },
  async captureScreenshot(mode: ScreenshotMode): Promise<ScreenshotData> {
    const r = await sendMessage<CaptureResponse>({ kind: 'POPUP_CAPTURE_SCREENSHOT', mode });
    if (!r.ok || !r.dataUrl) throw new Error(r.error ?? 'Screenshot capture failed');
    // Get real pixel dimensions by decoding the image.
    const dims = await imageDimensions(r.dataUrl);
    return {
      dataUrl: r.dataUrl,
      width: r.width ?? dims.width,
      height: r.height ?? dims.height,
      mode: r.mode ?? mode,
      capturedAt: new Date().toISOString(),
    };
  },
  async getEvidence(): Promise<EvidenceSnapshot> {
    return sendMessage({ kind: 'POPUP_GET_EVIDENCE' });
  },
  setPageInfo(info: PageInfo): Promise<{ ok: boolean }> {
    return sendMessage({ kind: 'POPUP_SET_PAGE_INFO', info });
  },
};

function imageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
}

/* ------------------------------------------------------------------ */
/* Page info via content script                                       */
/* ------------------------------------------------------------------ */

export async function capturePageContext(tabId: number): Promise<{
  pageInfo: PageInfo;
  environment: EnvironmentInfo;
}> {
  const fallbackEnv: EnvironmentInfo = {
    browserName: 'Chrome',
    browserVersion: 'unknown',
    operatingSystem: 'unknown',
    platform: navigator.platform,
    screenResolution: `${screen.width}x${screen.height}`,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    userAgent: navigator.userAgent,
    language: navigator.language,
  };

  let res: { pageInfo?: PageInfo; environment?: EnvironmentInfo };
  try {
    res = await chrome.tabs.sendMessage(tabId, { kind: 'CAPTURE_PAGE_INFO' });
  } catch {
    // Content script missing (e.g. chrome:// or injected after load) – use tab data.
    const tab = await chrome.tabs.get(tabId);
    return {
      pageInfo: {
        url: tab.url ?? '',
        title: tab.title ?? '',
        referrer: '',
        timestamp: new Date().toISOString(),
        tabId: tab.id ?? tabId,
        windowId: tab.windowId,
      },
      environment: fallbackEnv,
    };
  }

  const tab = await chrome.tabs.get(tabId);
  const pageInfo: PageInfo = {
    ...(res.pageInfo as PageInfo),
    tabId: tab.id ?? tabId,
    windowId: tab.windowId,
    url: tab.url ?? res.pageInfo?.url ?? '',
    title: tab.title ?? res.pageInfo?.title ?? '',
    referrer: res.pageInfo?.referrer ?? '',
  };
  return { pageInfo, environment: res.environment ?? fallbackEnv };
}

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
/* Backend API client (Phase 3). The OpenAI key NEVER lives here.     */
/* ------------------------------------------------------------------ */

export class BackendClient {
  constructor(private baseUrl: string) {}

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
    const r = await fetch(`${this.baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toAiPayload(report)),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      const text = await safeText(r);
      throw new Error(`AI analysis failed (${r.status}): ${text}`);
    }
    const json = (await r.json()) as { analysis: AiAnalysis };
    return json.analysis;
  }

  /** Upload screenshot; returns a hosted URL for the Sheets row. */
  async uploadScreenshot(reportId: string, dataUrl: string): Promise<string> {
    const r = await fetch(`${this.baseUrl}/api/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportId, image: dataUrl }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`Screenshot upload failed (${r.status})`);
    const json = (await r.json()) as { url: string };
    return json.url;
  }

  /** Submit the final row to Google Sheets through the backend. */
  async submitToSheets(report: BugReport, screenshotUrl?: string): Promise<{ rowId: string }> {
    const r = await fetch(`${this.baseUrl}/api/sheets/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report: toSheetPayload(report), screenshotUrl }),
      signal: AbortSignal.timeout(30_000),
    });
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
function toAiPayload(report: BugReport) {
  return {
    page: report.page,
    environment: report.environment,
    form: report.form,
    consoleEntries: report.consoleEntries.slice(-50),
    networkEntries: report.networkEntries.slice(-50),
    actions: report.actions.slice(-50),
    screenshot: report.screenshot
      ? { dataUrl: report.screenshot.dataUrl, mode: report.screenshot.mode }
      : null,
  };
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
