/**
 * QA Reporter – content script.
 *
 * Injected at document_start on every frame-less top-level page so that we can
 * install console/error hooks BEFORE any page script runs (otherwise early
 * errors are invisible to us).
 *
 * What it does while a report session is ACTIVE:
 *  - Buffers console.error/warn/info, window.onerror, unhandledrejection.
 *  - Tracks user actions (click / input / select / submit) with privacy rules.
 *  - Reports navigation events.
 *  - Answers CAPTURE_PAGE_INFO with URL + environment metrics.
 *
 * Privacy decisions (documented):
 *  - Input values are only captured for non-sensitive fields; password/email/
 *    tel/search inputs record the field NAME and "[REDACTED]" or nothing.
 *  - Batching: entries are flushed to the worker every 1s or when 20 items
 *    accumulate, whichever comes first, to keep messaging cheap.
 *  - When no session is active the script is completely passive (it only
 *    listens for messages), satisfying "only capture logs relevant to the
 *    current reporting session".
 */

import type {
  ConsoleEntry,
  EnvironmentInfo,
  PageInfo,
  RuntimeMessage,
  TrackedAction,
} from '../types';
import { cssPath, describeElement } from '../utils/format';
import { REDACTED, isSensitiveFieldName, redactBody } from '../utils/redaction';

let sessionActive = false;

/* ------------------------------------------------------------------ */
/* Console hooking                                                    */
/* ------------------------------------------------------------------ */

const consoleBuffer: ConsoleEntry[] = [];
const actionBuffer: TrackedAction[] = [];

type NativeConsole = typeof console;
const native = { ...console } as NativeConsole;

function callerFromStack(): { source: string; line?: number; column?: number; stack?: string } {
  try {
    const err = new Error();
    const stack = err.stack ?? '';
    // skip first frames belonging to our wrapper
    const frames = stack.split('\n').slice(3);
    const first = frames[0] ?? '';
    const m = first.match(/https?:\/\/[^\s()]+|file:\/\/[^\s()]+|[^\s()]+\.(js|mjs|ts)[^\s()]*/);
    let source = m ? m[0] : 'unknown';
    let line: number | undefined;
    let column: number | undefined;
    const loc = first.match(/:(\d+):(\d+)/);
    if (loc) {
      line = Number(loc[1]);
      column = Number(loc[2]);
      source = source.replace(/:\d+:\d+.*$/, '');
    }
    return { source: fileName(source), line, column, stack: frames.slice(0, 5).join('\n') };
  } catch {
    return { source: 'unknown' };
  }
}

function fileName(url: string): string {
  try {
    const u = new URL(url, location.href);
    return u.pathname.split('/').pop() || u.hostname;
  } catch {
    return url.split('/').pop() ?? url;
  }
}

function pushConsole(entry: ConsoleEntry): void {
  if (!sessionActive) return;
  consoleBuffer.push(entry);
  scheduleFlush();
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a, jsonSafeReplacer);
      } catch {
        return String(a);
      }
    })
    .join(' ')
    .slice(0, 2000);
}

/** JSON replacer that drops obviously sensitive keys. */
function jsonSafeReplacer(key: string, value: unknown): unknown {
  if (isSensitiveFieldName(key)) return REDACTED;
  return value;
}

for (const level of ['error', 'warn', 'info'] as const) {
  const original = native[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    if (!sessionActive) return;
    const loc = callerFromStack();
    pushConsole({
      type: level,
      message: redactBody(formatArgs(args)),
      source: loc.source,
      line: loc.line,
      column: loc.column,
      timestamp: new Date().toISOString(),
      stack: level === 'error' ? loc.stack : undefined,
    });
  };
}

window.addEventListener('error', (e) => {
  const target = e.target as Window | HTMLElement | null;
  const isResource = target && target !== window;
  pushConsole({
    type: 'exception',
    message: isResource
      ? `Resource load failed: ${(target as HTMLElement).tagName}`
      : `${e.message}`,
    source: isResource ? 'resource' : fileName(e.filename || location.href),
    line: e.lineno,
    column: e.colno,
    timestamp: new Date().toISOString(),
    stack: e.error?.stack ? String(e.error.stack).split('\n').slice(0, 6).join('\n') : undefined,
  });
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  const msg =
    reason instanceof Error
      ? `Unhandled rejection: ${reason.message}`
      : `Unhandled rejection: ${formatArgs([reason])}`;
  pushConsole({
    type: 'rejection',
    message: redactBody(msg),
    source: reason instanceof Error && reason.stack ? fileName(reason.stack) : location.href,
    timestamp: new Date().toISOString(),
    stack: reason instanceof Error ? reason.stack?.split('\n').slice(0, 6).join('\n') : undefined,
  });
});

/* ------------------------------------------------------------------ */
/* User action tracking                                               */
/* ------------------------------------------------------------------ */

const SENSITIVE_INPUT_TYPES = new Set(['password', 'email', 'tel', 'search', 'number']);

function pushAction(action: TrackedAction): void {
  if (!sessionActive) return;
  actionBuffer.push(action);
  scheduleFlush();
}

document.addEventListener(
  'click',
  (e) => {
    const el = e.target as Element | null;
    if (!el || !sessionActive) return;
    pushAction({
      type: 'click',
      label: `Clicked "${describeElement(el)}"`,
      target: cssPath(el),
      timestamp: new Date().toISOString(),
    });
  },
  true,
);

// Debounced per-element commit so typing produces ONE action, not one per key.
const pendingInputs = new Map<Element, ReturnType<typeof setTimeout>>();

function commitInput(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): void {
  const name = el.name || el.id || describeElement(el);
  let value: string | undefined;
  if (!SENSITIVE_INPUT_TYPES.has(el.type ?? 'text')) {
    value = redactBody(el.value).slice(0, 80);
  } else {
    value = REDACTED;
  }
  pushAction({
    type: el instanceof HTMLSelectElement ? 'select' : 'input',
    label: `Entered ${name}${value === REDACTED ? ' [REDACTED]' : ''}`,
    target: cssPath(el),
    value,
    timestamp: new Date().toISOString(),
  });
}

document.addEventListener(
  'change',
  (e) => {
    const el = e.target as Element | null;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return;
    commitInput(el);
  },
  true,
);

document.addEventListener(
  'input',
  (e) => {
    const el = e.target as Element | null;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    const prev = pendingInputs.get(el);
    if (prev) clearTimeout(prev);
    pendingInputs.set(
      el,
      setTimeout(() => {
        commitInput(el);
        pendingInputs.delete(el);
      }, 800),
    );
  },
  true,
);

document.addEventListener(
  'submit',
  (e) => {
    const form = e.target as HTMLFormElement | null;
    if (!form || !sessionActive) return;
    pushAction({
      type: 'form-submit',
      label: `Submitted form "${form.getAttribute('name') || form.id || describeElement(form)}"`,
      target: cssPath(form),
      timestamp: new Date().toISOString(),
    });
  },
  true,
);

// SPA-style navigation detection (history API) – full reloads are reported by
// the fresh document_start run itself.
function reportNavigation(label: string): void {
  pushAction({
    type: 'navigation',
    label,
    target: location.href,
    timestamp: new Date().toISOString(),
  });
}

const origPushState = history.pushState.bind(history);
history.pushState = function (...args: Parameters<typeof origPushState>) {
  origPushState(...args);
  reportNavigation(`Navigated to ${location.pathname}`);
};
window.addEventListener('popstate', () => reportNavigation(`Navigated back/forward to ${location.pathname}`));

/* On first run inside a session, announce the page load as a navigation. */
reportNavigation(`Page loaded: ${location.pathname}`);

/* ------------------------------------------------------------------ */
/* Flushing buffers to the service worker                             */
/* ------------------------------------------------------------------ */

let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (consoleBuffer.length + actionBuffer.length >= 20) {
    void flush();
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(() => void flush(), 1000);
}

async function flush(): Promise<void> {
  flushTimer = null;
  const c = consoleBuffer.splice(0);
  const a = actionBuffer.splice(0);
  try {
    if (c.length) await chrome.runtime.sendMessage({ kind: 'CONSOLE_ENTRIES', entries: c });
    if (a.length) await chrome.runtime.sendMessage({ kind: 'ACTION_TRACKING', actions: a });
  } catch {
    // Worker restarting – drop batch; next flush will include newer data.
  }
}

/* ------------------------------------------------------------------ */
/* Inbound messages                                                   */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage, _sender, sendResponse: (r?: unknown) => void) => {
    switch (message.kind) {
      case 'START_SESSION':
        sessionActive = true;
        sendResponse({ ok: true });
        return false;
      case 'END_SESSION':
        sessionActive = false;
        void flush();
        sendResponse({ ok: true });
        return false;
      case 'CAPTURE_PAGE_INFO': {
        const pageInfo: PageInfo = {
          url: location.href,
          title: document.title,
          referrer: document.referrer,
          timestamp: new Date().toISOString(),
          tabId: -1, // filled by background/popup from tabs API
          windowId: -1,
        };
        const env: EnvironmentInfo = collectEnvironment();
        sendResponse({ pageInfo, environment: env });
        return false;
      }
      default:
        return false;
    }
  },
);

export function collectEnvironment(): EnvironmentInfo {
  const ua = navigator.userAgent;
  const browserMatch =
    /(Chrome|Edg|Firefox|Safari)\/([\d.]+)/g;
  let browserName = 'Unknown';
  let browserVersion = '';
  let m: RegExpExecArray | null;
  const parts: Array<[string, string]> = [];
  while ((m = browserMatch.exec(ua))) parts.push([m[1], m[2]]);
  // Prefer Edg > Chrome > Firefox > Safari ordering present in UA
  const order = ['Edg', 'Chrome', 'Firefox', 'Safari'];
  for (const want of order) {
    const found = parts.find(([n]) => n === want);
    if (found) {
      browserName = found[0] === 'Edg' ? 'Edge' : found[0];
      browserVersion = found[1];
      break;
    }
  }
  let os = 'Unknown';
  if (/Windows NT 10/.test(ua)) os = 'Windows 10/11';
  else if (/Windows/.test(ua)) os = 'Windows';
  else {
    const macMatch = ua.match(/Mac OS X ([\d_]+)/);
    if (macMatch) os = `macOS ${macMatch[1].replace(/_/g, '.')}`;
    else if (/Android/.test(ua)) os = 'Android';
    else if (/(iPhone|iPad|iPod)/.test(ua)) os = 'iOS';
    else if (/CrOS/.test(ua)) os = 'ChromeOS';
    else if (/Linux/.test(ua)) os = 'Linux';
  }

  return {
    browserName,
    browserVersion,
    operatingSystem: os,
    platform: navigator.platform,
    screenResolution: `${screen.width}x${screen.height}`,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    userAgent: ua,
    language: navigator.language,
  };
}
