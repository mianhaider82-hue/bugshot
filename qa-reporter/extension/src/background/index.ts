/**
 * QA Reporter – background service worker (MV3).
 *
 * Responsibilities:
 *  - Keep an always-on, per-tab ring buffer of network requests via
 *    chrome.webRequest, so API failures that happened BEFORE the tester
 *    clicked the extension icon end up in the report.
 *  - While the popup is open, attach chrome.debugger (CDP Network + Log) to
 *    the active tab for richer evidence: response bodies of failed requests
 *    and the browser's own log (Log.enable replays entries collected so far).
 *  - On "capture": take the screenshot, snapshot all evidence into a draft
 *    report and open the editor page in a new tab next to the reported page.
 *
 * Documented Chrome API decisions
 * -------------------------------
 * 1. MV3 service workers are short-lived. The webRequest buffer is mirrored
 *    into chrome.storage.session (in-memory, cleared on browser restart) so a
 *    worker restart doesn't lose it. The popup keeps a runtime Port open,
 *    which keeps the worker alive while CDP is attached.
 * 2. Full-page screenshots use CDP Page.captureScreenshot with
 *    captureBeyondViewport (Chrome ≥ 108); fall back to viewport on failure.
 * 3. webRequest cannot read response bodies in MV3, hence the debugger on top.
 *    The debugger banner is unavoidable UX, so it is attached only while the
 *    popup is open and detached right after the capture.
 */

import type {
  BugReport,
  CaptureAndOpenResult,
  ConsoleEntry,
  EnvironmentInfo,
  NetworkEntry,
  PageInfo,
  RuntimeMessage,
  ScreenshotMode,
  TrackedAction,
} from '../types';
import { POPUP_PORT } from '../types';
import { loadSettings, nextBugId, saveDraft } from '../storage';
import { makeSessionId } from '../utils/format';

const MAX_BUFFER = 200; // bound memory per buffer

/* ------------------------------------------------------------------ */
/* Screenshot capture                                                 */
/* ------------------------------------------------------------------ */

interface CaptureResult {
  ok: boolean;
  dataUrl?: string;
  error?: string;
  mode?: ScreenshotMode;
}

async function captureViewport(windowId: number): Promise<CaptureResult> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    return { ok: true, dataUrl, mode: 'viewport' };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

async function captureFullPage(tabId: number, windowId: number): Promise<CaptureResult> {
  const target = { tabId };
  let attachedHere = false;
  try {
    if (cdpTab !== tabId) {
      await chrome.debugger.attach(target, '1.3');
      attachedHere = true;
    }
    await chrome.debugger.sendCommand(target, 'Page.enable');

    const metrics = (await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics')) as {
      cssContentSize?: { width: number; height: number };
      contentSize?: { width: number; height: number };
    };
    const size = metrics.cssContentSize ?? metrics.contentSize ?? { width: 0, height: 0 };
    // Chrome silently fails above ~16384px; clamp to a safe ceiling.
    const height = Math.min(Math.ceil(size.height), 16000);
    const width = Math.min(Math.ceil(size.width), 16000);

    const shot = (await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    })) as { data: string };

    return { ok: true, dataUrl: `data:image/png;base64,${shot.data}`, mode: 'fullpage' };
  } catch (e) {
    // Fall back to plain viewport capture rather than failing the report.
    const fb = await captureViewport(windowId);
    if (fb.ok) fb.error = `Full-page capture unavailable (${msg(e)}); captured visible screen instead.`;
    return fb;
  } finally {
    if (attachedHere) {
      try {
        await chrome.debugger.detach(target);
      } catch {
        /* already detached */
      }
    }
  }
}

async function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  try {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

/* ------------------------------------------------------------------ */
/* Always-on network buffer (chrome.webRequest)                       */
/* ------------------------------------------------------------------ */

const NET_KEY = 'qa_tab_network';
let tabNetwork: Record<string, NetworkEntry[]> = {};
const netReady: Promise<void> = chrome.storage.session
  .get(NET_KEY)
  .then((obj) => {
    tabNetwork = { ...((obj[NET_KEY] as Record<string, NetworkEntry[]>) ?? {}), ...tabNetwork };
  })
  .catch(() => undefined);

let netPersistTimer: ReturnType<typeof setTimeout> | null = null;
function persistNetwork(): void {
  if (netPersistTimer) return;
  netPersistTimer = setTimeout(() => {
    netPersistTimer = null;
    chrome.storage.session.set({ [NET_KEY]: tabNetwork }).catch(() => undefined);
  }, 500);
}

const requestStarts = new Map<string, { start: number; body?: string }>();
const ALWAYS_KEEP = new Set(['xmlhttprequest', 'main_frame', 'sub_frame']);

function isOwnRequest(d: { tabId: number; initiator?: string }): boolean {
  return d.tabId < 0 || (d.initiator ?? '').startsWith('chrome-extension://');
}

function recordWebRequest(tabId: number, entry: NetworkEntry): void {
  void netReady.then(() => {
    const list = (tabNetwork[tabId] ??= []);
    list.push(entry);
    if (list.length > MAX_BUFFER) list.splice(0, list.length - MAX_BUFFER);
    persistNetwork();
  });
}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (isOwnRequest(d) || d.type !== 'xmlhttprequest') return undefined;
    requestStarts.set(d.requestId, { start: d.timeStamp, body: decodeRequestBody(d.requestBody) });
    if (requestStarts.size > 500) {
      const oldest = requestStarts.keys().next().value;
      if (oldest) requestStarts.delete(oldest);
    }
    return undefined;
  },
  { urls: ['<all_urls>'] },
  ['requestBody'],
);

chrome.webRequest.onCompleted.addListener(
  (d) => {
    const started = requestStarts.get(d.requestId);
    requestStarts.delete(d.requestId);
    if (isOwnRequest(d)) return;
    if (!ALWAYS_KEEP.has(d.type) && d.statusCode < 400) return;
    recordWebRequest(d.tabId, {
      url: sanitizeUrlForLog(d.url),
      method: d.method,
      status: d.statusCode,
      statusText: d.statusLine?.replace(/^HTTP\/[\d.]+\s+\d+\s*/, '') || undefined,
      requestTimestamp: new Date(started?.start ?? d.timeStamp).toISOString(),
      responseTimestamp: new Date(d.timeStamp).toISOString(),
      durationMs: started ? Math.round(d.timeStamp - started.start) : undefined,
      resourceType: resourceTypeLabel(d.type),
      failed: false,
      requestBody: started?.body,
    });
  },
  { urls: ['<all_urls>'] },
);

chrome.webRequest.onErrorOccurred.addListener(
  (d) => {
    const started = requestStarts.get(d.requestId);
    requestStarts.delete(d.requestId);
    if (isOwnRequest(d)) return;
    // Cancelled sub-resources (page navigated away) are noise.
    if (!ALWAYS_KEEP.has(d.type) && d.error === 'net::ERR_ABORTED') return;
    recordWebRequest(d.tabId, {
      url: sanitizeUrlForLog(d.url),
      method: d.method,
      status: 0,
      requestTimestamp: new Date(started?.start ?? d.timeStamp).toISOString(),
      responseTimestamp: new Date(d.timeStamp).toISOString(),
      durationMs: started ? Math.round(d.timeStamp - started.start) : undefined,
      resourceType: resourceTypeLabel(d.type),
      failed: true,
      errorText: d.error,
      requestBody: started?.body,
    });
  },
  { urls: ['<all_urls>'] },
);

function decodeRequestBody(body: chrome.webRequest.WebRequestBody | null | undefined): string | undefined {
  if (!body) return undefined;
  try {
    if (body.formData) return truncateSafe(JSON.stringify(body.formData));
    const bytes = body.raw?.[0]?.bytes;
    if (bytes) return truncateSafe(new TextDecoder().decode(bytes));
  } catch {
    /* binary payload → skip */
  }
  return undefined;
}

function resourceTypeLabel(type: string): string {
  return type === 'xmlhttprequest' ? 'XHR/Fetch' : type === 'main_frame' ? 'Document' : type;
}

/* ------------------------------------------------------------------ */
/* Debugger capture while the popup is open (CDP Network + Log)       */
/* ------------------------------------------------------------------ */

interface PendingRequest {
  url: string;
  method: string;
  start: number;
  requestBody?: string;
  resourceType?: string;
  mimeType?: string;
}

let cdpTab: number | null = null;
let cdpNetwork: NetworkEntry[] = [];
let cdpConsole: ConsoleEntry[] = [];
const cdpIndexByRequestId = new Map<string, number>();
const cdpPending = new Map<string, PendingRequest>();

async function attachDebugger(tabId: number): Promise<boolean> {
  if (cdpTab === tabId) return true;
  await detachDebugger();
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    cdpTab = tabId;
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
      maxTotalBufferSize: 5_000_000,
      maxResourceBufferSize: 1_000_000,
    });
    // Log.enable replays the entries the browser collected so far
    // (failed resource loads, CSP / intervention warnings, …).
    await chrome.debugger.sendCommand({ tabId }, 'Log.enable');
    return true;
  } catch (e) {
    // DevTools already open on this tab, or a restricted page.
    console.warn('[qa-reporter] debugger unavailable:', e);
    await detachDebugger();
    return false;
  }
}

async function detachDebugger(): Promise<void> {
  const tabId = cdpTab;
  cdpTab = null;
  cdpNetwork = [];
  cdpConsole = [];
  cdpPending.clear();
  cdpIndexByRequestId.clear();
  if (tabId == null) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already detached */
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === cdpTab) {
    cdpTab = null;
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null || source.tabId !== cdpTab) return;
  const p = params as Record<string, unknown>;

  switch (method) {
    case 'Network.requestWillBeSent': {
      const req = p.request as { url: string; method: string; postData?: string };
      cdpPending.set(p.requestId as string, {
        url: req.url,
        method: req.method,
        start: Date.now(),
        requestBody: req.postData ? truncateSafe(req.postData) : undefined,
        resourceType: p.type as string | undefined,
      });
      break;
    }
    case 'Network.responseReceived': {
      const id = p.requestId as string;
      const pending = cdpPending.get(id);
      const resp = p.response as { status: number; statusText?: string; mimeType?: string };
      if (!pending) return;
      pending.mimeType = resp.mimeType;
      cdpNetwork.push({
        url: sanitizeUrlForLog(pending.url),
        method: pending.method,
        status: resp.status,
        statusText: resp.statusText,
        requestTimestamp: new Date(pending.start).toISOString(),
        responseTimestamp: new Date().toISOString(),
        durationMs: Date.now() - pending.start,
        resourceType: pending.resourceType,
        failed: false,
        requestBody: pending.requestBody,
      });
      if (cdpNetwork.length > MAX_BUFFER) cdpNetwork.shift();
      cdpIndexByRequestId.set(id, cdpNetwork.length - 1);
      break;
    }
    case 'Network.loadingFinished': {
      const id = p.requestId as string;
      const pending = cdpPending.get(id);
      const idx = cdpIndexByRequestId.get(id);
      cdpPending.delete(id);
      const entry = idx != null ? cdpNetwork[idx] : undefined;
      // Error responses deserve the body snippet – fetch it while attached.
      if (pending && entry && entry.status >= 400) void fetchResponseBody(id, pending.mimeType, entry);
      break;
    }
    case 'Network.loadingFailed': {
      const id = p.requestId as string;
      const pending = cdpPending.get(id);
      cdpPending.delete(id);
      if (!pending) return;
      cdpNetwork.push({
        url: sanitizeUrlForLog(pending.url),
        method: pending.method,
        status: 0,
        requestTimestamp: new Date(pending.start).toISOString(),
        responseTimestamp: new Date().toISOString(),
        durationMs: Date.now() - pending.start,
        resourceType: pending.resourceType,
        failed: true,
        errorText: (p.errorText as string) ?? 'net::ERR_FAILED',
        requestBody: pending.requestBody,
      });
      if (cdpNetwork.length > MAX_BUFFER) cdpNetwork.shift();
      break;
    }
    case 'Log.entryAdded': {
      const e = p.entry as { level: string; text: string; source: string; url?: string; lineNumber?: number; timestamp?: number };
      if (e.level === 'verbose') return;
      cdpConsole.push({
        type: e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : 'info',
        message: truncateSafe(e.text),
        source: e.url ? `${e.source}: ${fileName(e.url)}` : e.source,
        line: e.lineNumber,
        timestamp: new Date(e.timestamp ?? Date.now()).toISOString(),
      });
      if (cdpConsole.length > MAX_BUFFER) cdpConsole.shift();
      break;
    }
  }
});

/** Best effort: binary / streaming / evicted bodies are skipped. */
async function fetchResponseBody(requestId: string, mimeType: string | undefined, entry: NetworkEntry): Promise<void> {
  if (cdpTab == null || /image|font|video|audio|octet-stream|event-stream/i.test(mimeType ?? '')) return;
  try {
    const res = (await chrome.debugger.sendCommand({ tabId: cdpTab }, 'Network.getResponseBody', {
      requestId,
    })) as { body: string; base64Encoded: boolean };
    if (!res.base64Encoded) entry.responseBody = truncateSafe(res.body);
  } catch {
    /* evicted */
  }
}

/* ------------------------------------------------------------------ */
/* Popup lifecycle: attach CDP while it is open                       */
/* ------------------------------------------------------------------ */

let captureInProgress = false;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== POPUP_PORT) return;
  void (async () => {
    const settings = await loadSettings();
    if (!settings.privacy.collectNetwork && !settings.privacy.collectConsole) return;
    const tab = await activeTab();
    if (tab?.id != null && isReportable(tab.url)) await attachDebugger(tab.id);
  })();
  port.onDisconnect.addListener(() => {
    if (!captureInProgress) void detachDebugger();
  });
});

/* ------------------------------------------------------------------ */
/* Capture → draft → editor tab                                       */
/* ------------------------------------------------------------------ */

async function captureAndOpenEditor(mode: ScreenshotMode): Promise<CaptureAndOpenResult> {
  const tab = await activeTab();
  if (tab?.id == null) return { ok: false, error: 'No active tab to report on.' };
  if (!isReportable(tab.url)) {
    return { ok: false, error: 'QA Reporter cannot capture browser internal pages. Open a web page first.' };
  }
  const tabId = tab.id;
  captureInProgress = true;
  try {
    const shot = mode === 'fullpage' ? await captureFullPage(tabId, tab.windowId) : await captureViewport(tab.windowId);
    if (!shot.ok || !shot.dataUrl) return { ok: false, error: shot.error ?? 'Screenshot capture failed.' };

    const settings = await loadSettings();
    const errors: string[] = [];
    if (shot.error) errors.push(shot.error);

    const ctx = await pageContext(tab);
    const page = await contentBuffers(tabId);
    if (!page.available) {
      errors.push('Console logs unavailable: reload the page once after installing the extension.');
    }
    await netReady;

    const consoleEntries = settings.privacy.collectConsole
      ? [...page.consoleEntries, ...cdpConsole].sort(byTime((c) => c.timestamp))
      : [];
    const networkEntries = settings.privacy.collectNetwork ? mergeNetwork(tabNetwork[tabId] ?? [], cdpNetwork) : [];
    const actions = settings.privacy.trackActions ? page.actions : [];

    const now = new Date().toISOString();
    const report: BugReport = {
      id: await nextBugId(),
      sessionId: makeSessionId(),
      createdAt: now,
      updatedAt: now,
      status: 'draft',
      form: {
        reportType: 'bug',
        title: '',
        description: '',
        stepsToReproduce: [],
        expectedResult: '',
        actualResult: '',
        severity: 'Medium',
        priority: 'P2',
        additionalNotes: '',
      },
      page: ctx.pageInfo,
      environment: ctx.environment,
      screenshot: {
        dataUrl: shot.dataUrl,
        mode: shot.mode ?? mode,
        capturedAt: now,
        ...(await imageSize(shot.dataUrl)),
      },
      consoleEntries,
      networkEntries,
      actions,
      errors,
    };
    await saveDraft(report);
    await detachDebugger();

    await chrome.tabs.create({
      url: chrome.runtime.getURL(`editor/editor.html?session=${encodeURIComponent(report.sessionId)}`),
      index: tab.index + 1,
      openerTabId: tabId,
      windowId: tab.windowId,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: msg(e) };
  } finally {
    captureInProgress = false;
  }
}

/** Prefer CDP entries (they carry response bodies); add webRequest-only ones. */
function mergeNetwork(webReq: NetworkEntry[], cdp: NetworkEntry[]): NetworkEntry[] {
  const merged = [...cdp];
  for (const w of webReq) {
    const t = Date.parse(w.requestTimestamp);
    const dup = cdp.some(
      (c) => c.url === w.url && c.method === w.method && Math.abs(Date.parse(c.requestTimestamp) - t) < 2000,
    );
    if (!dup) merged.push(w);
  }
  return merged.sort(byTime((n) => n.requestTimestamp)).slice(-MAX_BUFFER);
}

async function pageContext(tab: chrome.tabs.Tab): Promise<{ pageInfo: PageInfo; environment: EnvironmentInfo }> {
  const tabId = tab.id ?? -1;
  const fallback: PageInfo = {
    url: tab.url ?? '',
    title: tab.title ?? '',
    referrer: '',
    timestamp: new Date().toISOString(),
    tabId,
    windowId: tab.windowId,
  };
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { kind: 'CAPTURE_PAGE_INFO' })) as {
      pageInfo: PageInfo;
      environment: EnvironmentInfo;
    };
    return {
      pageInfo: { ...res.pageInfo, tabId, windowId: tab.windowId, url: tab.url ?? res.pageInfo.url },
      environment: res.environment,
    };
  } catch {
    return {
      pageInfo: fallback,
      environment: {
        browserName: 'Chrome',
        browserVersion: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? 'unknown',
        operatingSystem: 'unknown',
        platform: '',
        screenResolution: 'unknown',
        viewportWidth: tab.width ?? 0,
        viewportHeight: tab.height ?? 0,
        devicePixelRatio: 1,
        userAgent: navigator.userAgent,
        language: navigator.language,
      },
    };
  }
}

async function contentBuffers(
  tabId: number,
): Promise<{ available: boolean; consoleEntries: ConsoleEntry[]; actions: TrackedAction[] }> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { kind: 'GET_BUFFERS' })) as {
      consoleEntries: ConsoleEntry[];
      actions: TrackedAction[];
    };
    return { available: true, consoleEntries: res.consoleEntries ?? [], actions: res.actions ?? [] };
  } catch {
    // Content script missing (tab opened before the extension was installed).
    return { available: false, consoleEntries: [], actions: [] };
  }
}

/* ------------------------------------------------------------------ */
/* Message routing                                                    */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse: (r: unknown) => void) => {
  switch (message.kind) {
    case 'CAPTURE_AND_OPEN_EDITOR':
      void captureAndOpenEditor(message.mode).then(sendResponse);
      return true; // async response
    case 'PING':
      sendResponse({ pong: true });
      return false;
    default:
      // Not ours (e.g. a message meant for another listener) – stay silent.
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === cdpTab) void detachDebugger();
  void netReady.then(() => {
    if (tabNetwork[tabId]) {
      delete tabNetwork[tabId];
      persistNetwork();
    }
  });
});

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

function isReportable(url: string | undefined): boolean {
  return !!url && !/^(chrome|chrome-extension|edge|about|devtools|view-source):/i.test(url) &&
    !url.startsWith('https://chromewebstore.google.com');
}

function byTime<T>(get: (x: T) => string): (a: T, b: T) => number {
  return (a, b) => Date.parse(get(a)) - Date.parse(get(b));
}

function sanitizeUrlForLog(url: string): string {
  // Lightweight redaction here; the full pipeline (utils/redaction) runs in
  // the editor before anything is sent to the AI or Sheets.
  try {
    const u = new URL(url);
    if (u.username || u.password) return `${u.protocol}//[REDACTED]@${u.host}${u.pathname}${u.search}`;
    return url;
  } catch {
    return url;
  }
}

function fileName(url: string): string {
  try {
    return new URL(url).pathname.split('/').pop() || url;
  } catch {
    return url;
  }
}

function truncateSafe(s: string): string {
  return s.length > 4000 ? `${s.slice(0, 4000)}… [truncated]` : s;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
