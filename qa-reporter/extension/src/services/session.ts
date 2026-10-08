/**
 * Extension ↔ backend session token.
 *
 * On install/first use the extension registers an anonymous reporter session
 * with the backend (POST /api/auth/session) and stores the returned bearer
 * token in chrome.storage.local. The backend uses it for rate limiting and
 * attribution ("Reporter" column). Google/OpenAI secrets never touch this.
 */

import { loadSettings } from '../storage';

const TOKEN_KEY = 'qa_backend_token';

export async function getAuthToken(): Promise<string | null> {
  const obj = await chrome.storage.local.get(TOKEN_KEY);
  const existing = obj[TOKEN_KEY] as string | undefined;
  if (existing) return existing;
  try {
    const settings = await loadSettings();
    const r = await fetch(`${settings.backendUrl}/api/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client: 'qa-reporter-extension' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const json = (await r.json()) as { token: string };
    await chrome.storage.local.set({ [TOKEN_KEY]: json.token });
    return json.token;
  } catch {
    return null; // backend offline → local-only mode still works
  }
}

export async function clearAuthToken(): Promise<void> {
  await chrome.storage.local.remove(TOKEN_KEY);
}
