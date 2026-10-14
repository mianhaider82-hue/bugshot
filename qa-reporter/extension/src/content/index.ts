/**
 * QA Reporter – content script.
 *
 * Injected at document_start on every frame-less top-level page so that we can
 * install console/error hooks BEFORE any page script runs (otherwise early
 * errors are invisible to us).
 *
 * What it does (always on, every page):
 *  - Keeps a local ring buffer of console.error/warn/info, window.onerror and
 *    unhandledrejection, so errors that happened BEFORE the tester clicked
 *    the extension icon are still available for the report.
 *  - Keeps a ring buffer of user actions (click / input / select / submit /
 *    navigation) with privacy rules.
 *  - Answers GET_BUFFERS (the background snapshots them at capture time) and
 *    CAPTURE_PAGE_INFO with URL + environment metrics.
 *
 * Privacy decisions (documented):
 *  - Input values are only captured for non-sensitive fields; password/email/
 *    tel/search inputs record the field NAME and "[REDACTED]" or nothing.
 *  - Buffers never leave the page on their own: nothing is sent anywhere
 *    until the tester takes a screenshot, and the redaction pipeline runs
 *    before anything leaves the device.
 */

import type {
  ConsoleEntry,
  EnvironmentInfo,
  PageInfo,
  ContentMessage,
  TrackedAction,
} from '../types';
import { cssPath, describeElement } from '../utils/format';
import { REDACTED, isSensitiveFieldName, redactBody } from '../utils/redaction';

const MAX_CONSOLE = 200;
const MAX_ACTIONS = 100;

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
  consoleBuffer.push(entry);
  if (consoleBuffer.length > MAX_CONSOLE) consoleBuffer.splice(0, consoleBuffer.length - MAX_CONSOLE);
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
  actionBuffer.push(action);
  if (actionBuffer.length > MAX_ACTIONS) actionBuffer.splice(0, actionBuffer.length - MAX_ACTIONS);
}

document.addEventListener(
  'click',
  (e) => {
    const el = e.target as Element | null;
    if (!el) return;
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
    if (!form) return;
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

/* Announce the page load as the first entry of the action timeline. */
reportNavigation(`Page loaded: ${location.pathname}`);

/* ------------------------------------------------------------------ */
/* Page visibility change detection                                   */
/* ------------------------------------------------------------------ */

/**
 * Documented Chrome API decision: MV3 forbids remote code and content scripts
 * cannot use chrome.debugger, so full-page screenshots are captured by the
 * service worker via CDP `captureBeyondViewport`. That mechanism requires the
 * tab to be VISIBLE; capturing a hidden/occluded tab produces blank output.
 * The popup therefore checks visibility before offering full-page mode.
 */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    pushAction({
      type: 'navigation',
      label: 'Tab became visible',
      target: location.href,
      timestamp: new Date().toISOString(),
    });
  }
});

/* ------------------------------------------------------------------ */
/* Inbound messages                                                   */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(
  (message: ContentMessage, _sender, sendResponse: (r?: unknown) => void) => {
    switch (message.kind) {
      case 'GET_BUFFERS':
        sendResponse({ consoleEntries: [...consoleBuffer], actions: [...actionBuffer] });
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
