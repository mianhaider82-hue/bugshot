/** Small helpers shared across contexts. */

/** Generate a short unique session id (crypto available in all extension contexts). */
export function makeSessionId(): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `SES-${rnd}`;
}

/** Format "BUG-0001" style ids from a numeric counter. */
export function formatBugId(n: number): string {
  return `BUG-${String(n).padStart(4, '0')}`;
}

/** Human time HH:MM:SS for action timeline. */
export function hhmmss(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour12: false });
  } catch {
    return iso;
  }
}

/** Best-effort readable label for a DOM element (aria-label > text > name > id). */
export function describeElement(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const text = (el.textContent ?? '').trim();
  if (text && text.length <= 40) return text.replace(/\s+/g, ' ');
  const name = el.getAttribute('name') || el.getAttribute('id');
  if (name) return name;
  return el.tagName.toLowerCase();
}

/** Compact CSS-ish path for debugging context (max 4 ancestors). */
export function cssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && parts.length < 4) {
    let sel = cur.tagName.toLowerCase();
    if (cur.id) sel += `#${cur.id}`;
    else if (typeof cur.className === 'string' && cur.className.trim()) {
      sel += `.${cur.className.trim().split(/\s+/)[0]}`;
    }
    parts.unshift(sel);
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}
