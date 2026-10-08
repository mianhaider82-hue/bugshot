/**
 * Redaction utilities – the single most important privacy layer.
 *
 * Rules are intentionally conservative: when in doubt, redact.
 * The rule set is configurable (see REDACTION_FIELD_NAMES) so teams can add
 * their own secret field names without touching matching logic.
 */

/** Header/field names whose values must always be redacted. Configurable. */
export let REDACTION_FIELD_NAMES: string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'password',
  'passwd',
  'pwd',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'apikey',
  'api_key',
  'secret',
  'client_secret',
  'session_id',
  'sessionid',
  'csrf',
  'xsrf',
  'credit_card',
  'card_number',
  'cvv',
  'cvc',
  'ssn',
];

export const REDACTED = '[REDACTED]';

/** Extend the sensitive-field list at runtime (settings-driven). */
export function configureRedaction(extraFields: string[]): void {
  const lower = extraFields.map((f) => f.toLowerCase().trim()).filter(Boolean);
  REDACTION_FIELD_NAMES = Array.from(new Set([...REDACTION_FIELD_NAMES, ...lower]));
}

export function isSensitiveFieldName(name: string): boolean {
  const n = name.toLowerCase();
  return REDACTION_FIELD_NAMES.some((f) => n === f || n.includes(f));
}

/**
 * Redact "key": "value" pairs inside a JSON-ish string body.
 * Also handles url-encoded form bodies (key=value&...).
 */
export function redactBody(body: string): string {
  if (!body) return body;
  let out = body;

  // JSON style:  "password": "hunter2"   /  "token":"abc"
  for (const field of REDACTION_FIELD_NAMES) {
    const jsonRe = new RegExp(`("${field}"\\s*:\\s*)"[^"]*"`, 'gi');
    out = out.replace(jsonRe, `$1"${REDACTED}"`);
    // numbers / booleans / nested objects for that key – best-effort:
    const jsonValRe = new RegExp(`("${field}"\\s*:\\s*)([^,{}\\[\\]]+)`, 'gi');
    out = out.replace(jsonValRe, `$1"${REDACTED}"`);
  }

  // URL-encoded form style: password=hunter2&email=a@b.c
  for (const field of REDACTION_FIELD_NAMES) {
    const formRe = new RegExp(`(^|[?&;])${field}=[^&#]*`, 'gi');
    out = out.replace(formRe, `$1${field}=${REDACTED}`);
  }

  // Common raw patterns regardless of field name
  out = out.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, `Bearer ${REDACTED}`);
  // Luhn-passing card numbers (simple grouping) e.g. 4111 1111 1111 1111 / 4111-1111-...
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => (luhnLike(m) ? REDACTED : m));

  return out;
}

/** Strip credentials embedded in URLs: https://user:pass@host → user/pass redacted */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = REDACTED;
      u.password = '';
    }
    for (const [k] of Array.from(u.searchParams.entries())) {
      if (isSensitiveFieldName(k)) u.searchParams.set(k, REDACTED);
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** Redact an HTTP header map by name. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = isSensitiveFieldName(k) ? REDACTED : v;
  }
  return out;
}

/** Truncate very large payloads before storage/upload. */
export function truncate(text: string | undefined, max = 4000): string | undefined {
  if (text == null) return undefined;
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

/** Very small Luhn check used only to avoid over-redacting long numeric ids. */
function luhnLike(digitsGrouped: string): boolean {
  const digits = digitsGrouped.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}
