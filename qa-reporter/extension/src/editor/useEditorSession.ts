/**
 * useEditorSession – state machine behind the editor tab.
 *
 *   loading → editing → analyzing → review → submitting → done
 *
 * The background worker has already captured the screenshot and evidence into
 * a draft (keyed by sessionId in the URL). Every edit is mirrored back into
 * the draft, so reloading or closing the tab never loses the report.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiAnalysis, AppSettings, BugReport, BugReportForm, ScreenshotData } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { clearDraft, getDraft, loadSettings, saveDraft, saveReport } from '../storage';
import { BackendClient, sanitizeReport } from '../services/api';

export type EditorPhase = 'loading' | 'missing' | 'editing' | 'analyzing' | 'review' | 'submitting' | 'done';

export interface EditorSession {
  phase: EditorPhase;
  settings: AppSettings;
  report: BugReport | null;
  error: string | null;
  notice: string | null;

  updateForm(patch: Partial<BugReportForm>): void;
  analyze(screenshot: Pick<ScreenshotData, 'dataUrl' | 'width' | 'height'> | null): Promise<void>;
  regenerateAi(): Promise<void>;
  backToEdit(): void;
  submitToSheets(): Promise<void>;
  saveLocal(): Promise<void>;
  discard(): Promise<void>;
  setNotice(n: string | null): void;
}

export function useEditorSession(sessionId: string | null): EditorSession {
  const [phase, setPhase] = useState<EditorPhase>('loading');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [report, setReport] = useState<BugReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void (async () => {
      setSettings(await loadSettings());
      const d = sessionId ? await getDraft(sessionId) : undefined;
      if (!d) return setPhase('missing');
      setReport(d);
      setPhase(d.status === 'ready' ? 'review' : 'editing');
    })();
  }, [sessionId]);

  /** Drafts hold multi-MB screenshots, so typing is saved debounced. */
  const persist = useCallback((r: BugReport, immediate = false) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (immediate) return saveDraft(r);
    saveTimer.current = setTimeout(() => void saveDraft(r), 400);
    return Promise.resolve();
  }, []);

  const commit = useCallback(
    async (next: BugReport, immediate = false) => {
      const stamped = { ...next, updatedAt: new Date().toISOString() };
      setReport(stamped);
      await persist(stamped, immediate);
      return stamped;
    },
    [persist],
  );

  const updateForm = useCallback(
    (patch: Partial<BugReportForm>) => {
      setReport((prev) => {
        if (!prev) return prev;
        const next = { ...prev, form: { ...prev.form, ...patch }, updatedAt: new Date().toISOString() };
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const runAi = useCallback(
    async (working: BugReport): Promise<BugReport> => {
      if (!settings.aiEnabled) return working;
      try {
        const ai = await new BackendClient(settings.backendUrl).analyze(working);
        return applyAi(working, ai);
      } catch (e) {
        setError(`AI analysis unavailable: ${msg(e)}. Fill in the fields manually or retry.`);
        return working;
      }
    },
    [settings],
  );

  const analyze = useCallback(
    async (shot: Pick<ScreenshotData, 'dataUrl' | 'width' | 'height'> | null) => {
      if (!report) return;
      setError(null);
      setPhase('analyzing');
      let working: BugReport = report;
      if (shot && working.screenshot) working = { ...working, screenshot: { ...working.screenshot, ...shot } };
      working = { ...sanitizeReport(working, settings.privacy.redactEnabled), status: 'ready' };
      working = await commit(working, true);
      working = await runAi(working);
      await commit(working, true);
      setPhase('review');
    },
    [report, settings, commit, runAi],
  );

  const regenerateAi = useCallback(async () => {
    if (!report) return;
    setError(null);
    setPhase('analyzing');
    await commit(await runAi(report), true);
    setPhase('review');
  }, [report, commit, runAi]);

  const backToEdit = useCallback(() => {
    setError(null);
    setPhase('editing');
  }, []);

  const finish = useCallback(async (r: BugReport) => {
    await saveReport(r);
    await clearDraft(r.sessionId);
    setReport(r);
    setPhase('done');
  }, []);

  const submitToSheets = useCallback(async () => {
    if (!report) return;
    if (!settings.sheetsSpreadsheetId) {
      setError('Choose a spreadsheet in Settings (extension popup → Settings) first.');
      return;
    }
    setError(null);
    setPhase('submitting');
    const client = new BackendClient(settings.backendUrl);
    let working = report;
    let screenshotUrl: string | undefined;
    if (working.screenshot) {
      try {
        screenshotUrl = await client.uploadScreenshot(working.id, working.screenshot.dataUrl);
      } catch (e) {
        working = withError(working, `Screenshot upload failed: ${msg(e)}`);
      }
    }
    try {
      const { rowId } = await client.submitToSheets(working, settings, screenshotUrl);
      await finish({ ...working, sheetRowId: rowId, status: 'submitted' });
      setNotice(`${working.id} added to Google Sheets.`);
    } catch (e) {
      // Keep the tester on the review screen so they can retry or export.
      await commit({ ...working, status: 'ready' }, true);
      setError(`Google Sheets failed: ${msg(e)}`);
      setPhase('review');
    }
  }, [report, settings, commit, finish]);

  const saveLocal = useCallback(async () => {
    if (!report) return;
    await finish({ ...report, status: report.status === 'submitted' ? 'submitted' : 'ready' });
    setNotice(`${report.id} saved in the extension.`);
  }, [report, finish]);

  const discard = useCallback(async () => {
    if (report) await clearDraft(report.sessionId);
    window.close();
  }, [report]);

  return {
    phase,
    settings,
    report,
    error,
    notice,
    updateForm,
    analyze,
    regenerateAi,
    backToEdit,
    submitToSheets,
    saveLocal,
    discard,
    setNotice,
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function withError(r: BugReport, e: string): BugReport {
  return { ...r, errors: [...r.errors, e] };
}

/**
 * Merge AI output into the form. A field is (re)filled when it is empty or
 * still holds the previous AI value, so regenerating refreshes AI text but
 * never overwrites something the tester typed.
 */
export function applyAi(r: BugReport, ai: AiAnalysis): BugReport {
  const prev = r.ai;
  const form = { ...r.form };
  const take = <K extends 'title' | 'description' | 'expectedResult' | 'actualResult'>(k: K, v: string) => {
    if (v && (!form[k] || form[k] === prev?.[k])) form[k] = v;
  };
  take('title', ai.title);
  take('description', ai.description || ai.summary);
  take('expectedResult', ai.expectedResult);
  take('actualResult', ai.actualResult);
  const steps = form.stepsToReproduce.filter(Boolean);
  if (ai.stepsToReproduce?.length && (!steps.length || sameList(steps, prev?.stepsToReproduce))) {
    form.stepsToReproduce = ai.stepsToReproduce;
  }
  if (ai.severity && (form.severity === 'Medium' || form.severity === prev?.severity)) form.severity = ai.severity;
  if (ai.priority && (form.priority === 'P2' || form.priority === prev?.priority)) form.priority = ai.priority;
  return { ...r, ai, form };
}

function sameList(a: string[], b: string[] | undefined): boolean {
  return !!b && a.length === b.length && a.every((x, i) => x === b[i]);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
