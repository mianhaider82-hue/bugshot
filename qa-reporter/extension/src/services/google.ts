/**
 * Google integration service (popup side).
 *
 * Documented Chrome API decision — OAuth flow:
 * We deliberately do NOT run chrome.identity in the extension. The backend is
 * the OAuth public client holding the refresh-token exchange; the popup opens
 * the backend's /api/auth/google/login URL in a normal browser tab and Google
 * redirects back to the backend's redirect URI, where tokens are stored
 * server-side (encrypted at rest on the backend). The extension then calls
 * backend APIs with its own session token. This keeps all Google credentials
 * off the client machine and works even when the tester's org blocks
 * chrome.identity.
 */

import { getAuthToken } from './session';
import type { SheetInfo } from './googleTypes';

export type { SheetInfo };

export function sheetsAuthUrl(backendUrl: string): string {
  return `${backendUrl}/api/auth/google/login`;
}

async function authedFetch(backendUrl: string, path: string, init?: RequestInit): Promise<Response> {
  const token = await getAuthToken();
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${backendUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
}

export async function listSheets(backendUrl: string): Promise<SheetInfo[]> {
  const r = await authedFetch(backendUrl, '/api/sheets/list');
  if (!r.ok) throw new Error(r.status === 401 ? 'Google account not connected. Use "Connect Google" first.' : `Failed (${r.status})`);
  const json = (await r.json()) as { sheets: SheetInfo[] };
  return json.sheets;
}

export async function listWorksheets(backendUrl: string, spreadsheetId: string): Promise<string[]> {
  const r = await authedFetch(backendUrl, `/api/sheets/worksheets?spreadsheetId=${encodeURIComponent(spreadsheetId)}`);
  if (!r.ok) throw new Error(`Failed (${r.status})`);
  const json = (await r.json()) as { worksheets: Array<{ title: string }> };
  return json.worksheets.map((w) => w.title);
}
