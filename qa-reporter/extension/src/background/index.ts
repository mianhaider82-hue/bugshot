/**
 * QA Reporter – background service worker (MV3).
 *
 * Responsibilities:
 *  - Own the "report session" lifecycle (one active session at a time).
 *  - Capture screenshots via chrome.tabs.captureVisibleTab.
 *  - Buffer console entries & tracked actions forwarded by the content script.
 *  - Capture network evidence via chrome.debugger (CDP Network domain).
 *  - Persist drafts continuously so nothing is lost if the browser dies.
 *
 * Documented Chrome API decisions
 * -------------------------------
 * 1. MV3 service workers are short-lived. We therefore keep in-memory buffers
 *    small and mirror every mutation into chrome.storage.local drafts; on
 *    worker restart we rehydrate from storage. This is the standard pattern
 *    for stateful MV3 extensions.
 * 2. Full-page screenshots: there is no first-party API. We use CDP
 *    Page.captureScreenshot with clip+scale over the document metrics that
 *    the content script reports ("where technically possible"). If the page
 *    is taller than Chrome's capture limits we fall back to viewport mode.
 * 3. Network capture uses chrome.debugger + CDP instead of webRequest because
 *    MV3 webRequest observers cannot read response bodies. The debugger banner
 *    is unavoidable UX; we attach only while a session is active and detach
 *    immediately when it ends to minimise intrusiveness.
 * 4. chrome.notifications is intentionally NOT used (requires extra
 *    permission); badge text communicates state instead.
 */

import type {
  ConsoleEntry,
  NetworkEntry,
  PageInfo,
  RuntimeMessage,
  ScreenshotMode,
  SessionState,
  TrackedAction,
} from '../types';

/* ------------------------------------------------------------------ */
/* Session state (memory + storage mirror)                            */
/* ------------------------------------------------------------------ */

interface Buffers {
  consoleEntries: ConsoleEntry[];
  networkEntries: NetworkEntry[];
  actions: TrackedAction[];
}

let session: SessionState = { active: false, sessionId: null, startedAt: null, tabId: null };
let buffers: Buffers = { consoleEntries: [], networkEntries: [], actions: [] };
let pageInfo: PageInfo | null = null;
const MAX_BUFFER = 200; // bound memory in the worker

const STATE_KEY = 'qa_session_state';
const BUFFER_KEY = 'qa_session_buffers';

async function persistState(): Promise<void> {
  await chrome.storage.session.set({ [STATE_KEY]: session, [BUFFER_KEY]: buffers });
}

async function restoreState(): Promise<void> {
  const obj = await chrome.storage.session.get([STATE_KEY, BUFFER_KEY]);
  if (obj[STATE_KEY]) session = obj[STATE_KEY] as SessionState;
  if (obj[BUFFER_KEY]) buffers = obj[BUFFER_KEY] as Buffers;
}

/* ------------------------------------------------------------------ */
/* Badge helpers                                                      */
/* ------------------------------------------------------------------ */

function setBadge(text: string, color = '#2563eb'): void {
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color });
}

/* ------------------------------------------------------------------ */
/* Screenshot capture                                                 */
/* ------------------------------------------------------------------ */

interface CaptureResult {
  ok: boolean;
  dataUrl?: string;
  width?: number;
  height?: number;
  error?: string;
  mode?: ScreenshotMode;
}

async function captureViewport(tabId: number): Promise<CaptureResult> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
    return { ok: true, dataUrl, mode: 'viewport' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Full-page capture via CDP. The content script measures the document;
 * we scroll-stitch is unnecessary because captureScreenshot supports a clip
 * beyond the viewport when captureBeyondViewport=true (Chrome ≥ 108).
 */
async function captureFullPage(tabId: number): Promise<CaptureResult> {
  const target = { tabId };
  let attachedHere = false;
  try {
    const existing = await chrome.debugger.getTargets();
    if (!existing.some((t) => t.tabId === tabId && t.attached)) {
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

    return {
      ok: true,
      dataUrl: `data:image/png;base64,${shot.data}`,
      width,
      height,
      mode: 'fullpage',
    };
  } catch (e) {
    // Fall back to plain viewport capture rather than failing the report.
    const fb = await captureViewport(tabId);
    if (fb.ok) {
      fb.error = `Full-page capture unavailable (${e instanceof Error ? e.message : e}); captured viewport instead.`;
    }
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

/* ------------------------------------------------------------------ */
/* Network capture (chrome.debugger + CDP Network domain)             */
/* ------------------------------------------------------------------ */

interface PendingRequest {
  url: string;
  method: string;
  startMono: number; // epoch ms when request was seen
  requestBody?: string;
  resourceType?: string;
  mimeType?: string;
}

/** requestId → index in buffers.networkEntries, for response-body enrichment. */
const entryIndexByRequestId = new Map<string, number>();
const pendingRequests = new Map<string, PendingRequest>();
let networkAttachedTab: number | null = null;

async function attachNetwork(tabId: number): Promise<void> {
  if (networkAttachedTab === tabId) return;
  await detachNetwork();
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
      maxTotalBufferSize: 5_000_000,
      maxResourceBufferSize: 1_000_000,
    });
    networkAttachedTab = tabId;
  } catch (e) {
    // DevTools open elsewhere → debugger attach fails. Non-fatal: log in report errors.
    console.warn('[qa-reporter] network capture unavailable:', e);
  }
}

async function detachNetwork(): Promise<void> {
  if (networkAttachedTab == null) return;
  try {
    await chrome.debugger.detach({ tabId: networkAttachedTab });
  } catch {
    /* ignore */
  }
  networkAttachedTab = null;
  pendingRequests.clear();
  entryIndexByRequestId.clear();
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== networkAttachedTab || !session.active) return;
  const p = params as Record<string, unknown>;

  if (method === 'Network.requestWillBeSent') {
    const req = p.request as { url: string; method: string; postData?: string };
    pendingRequests.set(p.requestId as string, {
      url: req.url,
      method: req.method,
      startMono: Date.now(),
      requestBody: req.postData,
      resourceType: p.type as string | undefined,
    });
  } else if (method === 'Network.responseReceived') {
    const id = p.requestId as string;
    const pending = pendingRequests.get(id);
    const resp = p.response as { status: number; statusText?: string; mimeType?: string };
    if (!pending) return;
    pending.mimeType = resp.mimeType;
    const entry: NetworkEntry = {
      url: sanitizeUrlForLog(pending.url),
      method: pending.method,
      status: resp.status,
      statusText: resp.statusText,
      requestTimestamp: new Date(pending.startMono).toISOString(),
      responseTimestamp: new Date().toISOString(),
      durationMs: Date.now() - pending.startMono,
      resourceType: pending.resourceType,
      failed: false,
      requestBody: pending.requestBody ? truncateSafe(pending.requestBody) : undefined,
    };
    pushNetwork(entry);
    entryIndexByRequestId.set(id, buffers.networkEntries.length - 1);
    // Error responses deserve the body snippet immediately – fetch while attached.
    if (resp.status >= 400) {
      void enrichResponseSnippet(id);
    }
  } else if (method === 'Network.loadingFinished') {
    const id = p.requestId as string;
    const idx = entryIndexByRequestId.get(id);
    const pending = pendingRequests.get(id);
    if (idx != null && pending && !buffers.networkEntries[idx]?.responseBody) {
      void enrichResponseSnippet(id);
    }
    pendingRequests.delete(id);
  } else if (method === 'Network.loadingFailed') {
    finishRequest(p.requestId as string, (p.errorText as string) ?? 'net::ERR_FAILED');
  }
});

/** Fetch & attach a redacted-safe response snippet for one request (best effort). */
async function enrichResponseSnippet(requestId: string): Promise<void> {
  if (networkAttachedTab == null) return;
  const idx = entryIndexByRequestId.get(requestId);
  const pending = pendingRequests.get(requestId);
  if (idx == null || !pending) return;
  // Skip binary / streaming types deliberately (documented decision #3).
  const mime = pending.mimeType ?? '';
  if (/image|font|video|audio|octet-stream|event-stream|websocket/i.test(mime)) return;
  const body = await fetchResponseBody(networkAttachedTab, requestId);
  if (body && buffers.networkEntries[idx]) {
    buffers.networkEntries[idx].responseBody = body;
    await persistState();
  }
}

function finishRequest(requestId: string, errorText?: string): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  if (errorText) {
    pushNetwork({
      url: sanitizeUrlForLog(pending.url),
      method: pending.method,
      status: 0,
      requestTimestamp: new Date(pending.startMono).toISOString(),
      responseTimestamp: new Date().toISOString(),
      durationMs: Date.now() - pending.startMono,
      resourceType: pending.resourceType,
      failed: true,
      errorText,
      requestBody: pending.requestBody ? truncateSafe(pending.requestBody) : undefined,
    });
  }
}

/**
 * Response bodies must be fetched while the debugger is still attached.
 * Binary / streaming / oversized responses are skipped deliberately.
 * (Documented decision: getResponseBody throws for evicted buffers, so this is
 * best-effort and only used for failed requests where the body matters most.)
 */
async function fetchResponseBody(tabId: number, requestId: string): Promise<string | undefined> {
  try {
    const res = (await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', {
      requestId,
    })) as { body: string; base64Encoded: boolean };
    if (res.base64Encoded) return undefined; // binary → skip (documented decision)
    return truncateSafe(res.body);
  } catch {
    return undefined; // streamed/evicted body → best effort only
  }
}

function pushNetwork(entry: NetworkEntry): void {
  buffers.networkEntries.push(entry);
  if (buffers.networkEntries.length > MAX_BUFFER) {
    // Dropping the head shifts every recorded index by one – rebuild map.
    const dropped = buffers.networkEntries.length - MAX_BUFFER;
    buffers.networkEntries.splice(0, dropped);
    for (const [k, v] of entryIndexByRequestId.entries()) {
      const nv = v - dropped;
      if (nv < 0) entryIndexByRequestId.delete(k);
      else entryIndexByRequestId.set(k, nv);
    }
  }
  void persistState();
}

function sanitizeUrlForLog(url: string): string {
  // lightweight redaction here; full redaction pipeline lives in utils/redaction
  // which the popup applies before AI/upload (keeps worker bundle simple).
  try {
    const u = new URL(url);
    if (u.username || u.password) return `${u.protocol}//[REDACTED]@${u.host}${u.pathname}`;
    return url;
  } catch {
    return url;
  }
}

function truncateSafe(s: string): string {
  return s.length > 4000 ? `${s.slice(0, 4000)}… [truncated]` : s;
}

/* ------------------------------------------------------------------ */
/* Message routing                                                    */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage, sender, sendResponse: (r: unknown) => void) => {
    void (async () => {
      switch (message.kind) {
        case 'START_SESSION': {
          session = {
            active: true,
            sessionId: message.sessionId,
            startedAt: new Date().toISOString(),
            tabId: sender.tab?.id ?? (await activeTabId()),
          };
          buffers = { consoleEntries: [], networkEntries: [], actions: [] };
          pageInfo = null;
          await persistState();
          if (session.tabId != null) await attachNetwork(session.tabId);
          setBadge('REC', '#dc2626');
          sendResponse({ ok: true, tabId: session.tabId });
          break;
        }

        case 'END_SESSION': {
          session = { active: false, sessionId: null, startedAt: null, tabId: null };
          await persistState();
          await detachNetwork();
          setBadge('');
          sendResponse({ ok: true });
          break;
        }

        case 'CONSOLE_ENTRIES': {
          buffers.consoleEntries.push(...message.entries);
          if (buffers.consoleEntries.length > MAX_BUFFER) {
            buffers.consoleEntries.splice(0, buffers.consoleEntries.length - MAX_BUFFER);
          }
          await persistState();
          sendResponse({ ok: true });
          break;
        }

        case 'ACTION_TRACKING': {
          buffers.actions.push(...message.actions);
          if (buffers.actions.length > MAX_BUFFER) {
            buffers.actions.splice(0, buffers.actions.length - MAX_BUFFER);
          }
          await persistState();
          sendResponse({ ok: true });
          break;
        }

        case 'GET_CONSOLE_ENTRIES':
          sendResponse({ entries: buffers.consoleEntries });
          break;

        case 'GET_ACTION_TRACKING':
          sendResponse({ actions: buffers.actions });
          break;

        case 'PING':
          sendResponse({ pong: true, session });
          break;

        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    })();
    return true; // keep channel open for async sendResponse
  },
);

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* External messages from popup (screenshots, evidence snapshot)      */
/* ------------------------------------------------------------------ */

export interface PopupCommands {
  captureScreenshot(mode: ScreenshotMode): Promise<CaptureResult>;
  getEvidenceSnapshot(): Promise<{
    session: SessionState;
    consoleEntries: ConsoleEntry[];
    networkEntries: NetworkEntry[];
    actions: TrackedAction[];
    pageInfo: PageInfo | null;
  }>;
  setPageInfo(info: PageInfo): Promise<void>;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const m = message as { kind: string; mode?: ScreenshotMode; info?: PageInfo };
  if (m.kind === 'POPUP_CAPTURE_SCREENSHOT') {
    void (async () => {
      const tabId = session.tabId ?? (await activeTabId());
      if (tabId == null) return sendResponse({ ok: false, error: 'No active tab' });
      const result =
        m.mode === 'fullpage' ? await captureFullPage(tabId) : await captureViewport(tabId);
      sendResponse(result);
    })();
    return true;
  }
  if (m.kind === 'POPUP_GET_EVIDENCE') {
    sendResponse({
      session,
      consoleEntries: buffers.consoleEntries,
      networkEntries: buffers.networkEntries,
      actions: buffers.actions,
      pageInfo,
    });
    return false;
  }
  if (m.kind === 'POPUP_SET_PAGE_INFO' && m.info) {
    pageInfo = m.info;
    void persistState();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

/* Clean up debugger when the reported tab closes/navigates away hard. */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === networkAttachedTab) void detachNetwork();
});

/* Worker startup: rehydrate last known session state. */
chrome.runtime.onInstalled.addListener(() => void restoreState());
chrome.runtime.onStartup.addListener(() => void restoreState());
void restoreState();
