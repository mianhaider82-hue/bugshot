/**
 * Storage layer – a thin typed wrapper over chrome.storage.local.
 *
 * Why chrome.storage.local (not sessionStorage/IndexedDB):
 *  - Survives browser restarts → enables draft recovery (requirement #19).
 *  - Quota: with "unlimitedStorage" absent we still get ~10MB which is enough
 *    for screenshots kept as data URLs for short-lived drafts. Large binaries
 *    are uploaded to backend storage in Phase 4; only the URL is persisted.
 */

import type { AppSettings, BugReport } from '../types';
import { DEFAULT_SETTINGS as DEFAULTS } from '../types';

const KEYS = {
  reports: 'qa_reports', // BugReport[] (most recent first)
  drafts: 'qa_drafts', // BugReport[] unfinished sessions
  settings: 'qa_settings', // AppSettings
  counter: 'qa_bug_counter', // number – next BUG-#### id
} as const;

/* ------------------------------------------------------------------ */
/* Generic helpers                                                     */
/* ------------------------------------------------------------------ */

async function get<T>(key: string, fallback: T): Promise<T> {
  const obj = await chrome.storage.local.get(key);
  return (obj[key] as T) ?? fallback;
}

async function set(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

export async function loadSettings(): Promise<AppSettings> {
  const stored = await get<Partial<AppSettings>>(KEYS.settings, {});
  // deep-merge defaults so new fields added later never come back undefined
  return {
    ...DEFAULTS,
    ...stored,
    privacy: { ...DEFAULTS.privacy, ...(stored.privacy ?? {}) },
  };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await set(KEYS.settings, settings);
}

/* ------------------------------------------------------------------ */
/* Bug counter (BUG-0001 ids)                                         */
/* ------------------------------------------------------------------ */

export async function nextBugId(): Promise<string> {
  const n = await get<number>(KEYS.counter, 0) + 1;
  await set(KEYS.counter, n);
  return `BUG-${String(n).padStart(4, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Reports                                                            */
/* ------------------------------------------------------------------ */

export async function listReports(): Promise<BugReport[]> {
  return get<BugReport[]>(KEYS.reports, []);
}

export async function saveReport(report: BugReport): Promise<void> {
  const all = await listReports();
  const idx = all.findIndex((r) => r.id === report.id);
  if (idx >= 0) all[idx] = report;
  else all.unshift(report); // newest first
  // Bound local history at 50 reports.
  const trimmed = all.slice(0, 50);
  try {
    await set(KEYS.reports, trimmed);
  } catch {
    // Likely quota exceeded → retry keeping screenshots only for the newest 10.
    await set(
      KEYS.reports,
      trimmed.map((r, i) => (i < 10 ? r : { ...r, screenshot: undefined })),
    );
  }
}

export async function deleteReport(id: string): Promise<void> {
  const all = await listReports();
  await set(
    KEYS.reports,
    all.filter((r) => r.id !== id),
  );
}

/* ------------------------------------------------------------------ */
/* Drafts (crash-safe recovery)                                       */
/* ------------------------------------------------------------------ */

export async function listDrafts(): Promise<BugReport[]> {
  return get<BugReport[]>(KEYS.drafts, []);
}

/** Upsert a draft. Called frequently during a session – must be cheap & safe. */
export async function saveDraft(draft: BugReport): Promise<void> {
  const all = await listDrafts();
  const idx = all.findIndex((d) => d.sessionId === draft.sessionId);
  if (idx >= 0) all[idx] = draft;
  else all.unshift(draft);
  try {
    await set(KEYS.drafts, all.slice(0, 10));
  } catch {
    // quota – store metadata only
    await set(
      KEYS.drafts,
      all.slice(0, 10).map((d) => ({ ...d, screenshot: undefined })),
    );
  }
}

export async function clearDraft(sessionId: string): Promise<void> {
  const all = await listDrafts();
  await set(
    KEYS.drafts,
    all.filter((d) => d.sessionId !== sessionId),
  );
}
