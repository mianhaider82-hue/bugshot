/**
 * useReportSession – the state machine behind the whole workflow.
 *
 *   idle → capturing → evidence → review → submitting → done
 *
 * Every transition persists a draft (requirement #19) so the popup can be
 * closed / browser killed at any point and the session is recoverable.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppSettings,
  BugReport,
  BugReportForm,
  ScreenshotData,
  ScreenshotMode,
  Severity,
  Priority,
} from '../types';
import { DEFAULT_SETTINGS } from '../types';
import {
  clearDraft,
  listDrafts,
  loadSettings,
  nextBugId,
  saveDraft,
  saveSettings,
} from '../storage';
import {
  BackendClient,
  backgroundService,
  capturePageContext,
  sanitizeReport,
} from '../services/api';
import { makeSessionId } from '../utils/format';

export type SessionPhase =
  | 'idle'
  | 'capturing' // taking screenshot
  | 'annotating' // editor open
  | 'evidence' // collecting logs / filling form
  | 'analyzing' // AI round-trip
  | 'review' // reviewing AI output
  | 'submitting'
  | 'done';

const EMPTY_FORM: BugReportForm = {
  title: '',
  description: '',
  stepsToReproduce: [],
  expectedResult: '',
  actualResult: '',
  severity: 'Medium',
  priority: 'P2',
  additionalNotes: '',
};

export interface ReportSession {
  phase: SessionPhase;
  settings: AppSettings;
  report: BugReport | null;
  busyMessage: string | null;
  error: string | null;

  startReport(): Promise<void>;
  recoverDraft(sessionId: string): Promise<void>;
  setScreenshot(shot: ScreenshotData): void;
  retakeScreenshot(mode: ScreenshotMode): Promise<void>;
  cancelReport(): Promise<void>;
  updateForm(patch: Partial<BugReportForm>): void;
  finishEvidence(): Promise<void>; // collect buffers + page info → review
  regenerateAi(): Promise<void>;
  submit(): Promise<void>;
  saveSettings(settings: AppSettings): Promise<void>;
  reset(): void;
}

export function useReportSession(): ReportSession {
  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [report, setReport] = useState<BugReport | null>(null);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tabIdRef = useRef<number | null>(null);

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  const patchReport = useCallback(
    async (updater: (r: BugReport) => BugReport) => {
      setReport((prev) => {
        if (!prev) return prev;
        const next = { ...updater(prev), updatedAt: new Date().toISOString() };
        void saveDraft(next); // crash-safe mirror on every change
        return next;
      });
    },
    [],
  );

  /* ---------------- lifecycle ---------------- */

  const startReport = useCallback(async () => {
    setError(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab to report on.');
      if (/^(chrome|edge|about|devtools):/i.test(tab.url ?? '')) {
        throw new Error('QA Reporter cannot run on browser internal pages. Open a web page first.');
      }
      tabIdRef.current = tab.id;
      const sessionId = makeSessionId();

      setPhase('capturing');
      await backgroundService.startSession(sessionId);
      // Tell content script too (it may not have been injected yet → ignore errors).
      try {
        await chrome.tabs.sendMessage(tab.id, { kind: 'START_SESSION', sessionId });
      } catch {
        /* will fall back to tabs-API page info */
      }

      const base: BugReport = {
        id: await peekOrAssignId(),
        sessionId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'draft',
        form: { ...EMPTY_FORM },
        page: {
          url: tab.url ?? '',
          title: tab.title ?? '',
          referrer: tab.referrer ?? '',
          timestamp: new Date().toISOString(),
          tabId: tab.id,
          windowId: tab.windowId,
        },
        environment: placeholderEnv(),
        consoleEntries: [],
        networkEntries: [],
        actions: [],
        errors: [],
      };
      setReport(base);
      await saveDraft(base);
      setPhase('annotating');
    } catch (e) {
      setError(msg(e));
      setPhase('idle');
    }
  }, []);

  const recoverDraft = useCallback(async (sessionId: string) => {
    const drafts = await listDrafts();
    const d = drafts.find((x) => x.sessionId === sessionId);
    if (!d) return;
    setReport(d);
    setError(null);
    setPhase(d.screenshot ? 'evidence' : 'annotating');
  }, []);

  const setScreenshot = useCallback(
    (shot: ScreenshotData) => {
      void patchReport((r) => ({ ...r, screenshot: shot }));
      setPhase('evidence');
    },
    [patchReport],
  );

  const retakeScreenshot = useCallback(
    async (mode: ScreenshotMode) => {
      setBusyMessage('Capturing screenshot…');
      try {
        const shot = await backgroundService.captureScreenshot(mode);
        void patchReport((r) => ({ ...r, screenshot: shot }));
      } catch (e) {
        setError(msg(e)); // requirement #18: never lose the report
      } finally {
        setBusyMessage(null);
      }
    },
    [patchReport],
  );

  const cancelReport = useCallback(async () => {
    if (report) {
      await clearDraft(report.sessionId);
      try {
        await backgroundService.endSession(report.sessionId);
        if (tabIdRef.current) {
          await chrome.tabs.sendMessage(tabIdRef.current, { kind: 'END_SESSION' });
        }
      } catch {
        /* best effort */
      }
    }
    setReport(null);
    setPhase('idle');
    setError(null);
  }, [report]);

  const updateForm = useCallback(
    (patch: Partial<BugReportForm>) => {
      void patchReport((r) => ({ ...r, form: { ...r.form, ...patch } }));
    },
    [patchReport],
  );

  /* ---------------- evidence + AI ---------------- */

  const finishEvidence = useCallback(async () => {
    if (!report) return;
    setPhase('evidence');
    setBusyMessage('Collecting technical evidence…');
    let working = report;
    try {
      // 1. Page/environment context
      if (tabIdRef.current) {
        try {
          const ctx = await capturePageContext(tabIdRef.current);
          working = { ...working, page: ctx.pageInfo, environment: ctx.environment };
          await backgroundService.setPageInfo(ctx.pageInfo);
        } catch (e) {
          working = withError(working, `Page info incomplete: ${msg(e)}`);
        }
      }
      // 2. Console/network/action buffers from the worker
      try {
        const ev = await backgroundService.getEvidence();
        working = {
          ...working,
          consoleEntries: ev.consoleEntries,
          networkEntries: ev.networkEntries,
          actions: ev.actions,
        };
      } catch (e) {
        working = withError(working, `Evidence collection degraded: ${msg(e)}`);
      }
      // 3. Redact before anything leaves the device
      working = sanitizeReport(working, settings.privacy.redactEnabled);
      working = { ...working, status: 'ready' };
      setReport(working);
      await saveDraft(working);
    } finally {
      setBusyMessage(null);
    }

    // 4. AI analysis (optional, failure-tolerant)
    if (settings.aiEnabled) {
      setPhase('analyzing');
      setBusyMessage('AI is analyzing the evidence…');
      try {
        const client = new BackendClient(settings.backendUrl);
        const ai = await client.analyze(working);
        setReport((prev) => {
          if (!prev) return prev;
          const merged = applyAi(prev, ai);
          void saveDraft(merged);
          return merged;
        });
      } catch (e) {
        setReport((prev) => (prev ? withError(prev, `AI unavailable: ${msg(e)}`) : prev));
      } finally {
        setBusyMessage(null);
      }
    }
    setPhase('review');
  }, [report, settings]);

  const regenerateAi = useCallback(async () => {
    if (!report) return;
    setPhase('analyzing');
    setBusyMessage('Regenerating AI analysis…');
    try {
      const client = new BackendClient(settings.backendUrl);
      const ai = await client.analyze(sanitizeReport(report, settings.privacy.redactEnabled));
      setReport((prev) => {
        if (!prev) return prev;
        const merged = applyAi(prev, ai);
        void saveDraft(merged);
        return merged;
      });
    } catch (e) {
      setError(`AI regeneration failed: ${msg(e)}`);
    } finally {
      setBusyMessage(null);
      setPhase('review');
    }
  }, [report, settings]);

  /* ---------------- submit ---------------- */

  const submit = useCallback(async () => {
    if (!report) return;
    setPhase('submitting');
    setError(null);
    let working = report;
    const client = new BackendClient(settings.backendUrl);

    // 1. Screenshot upload (non-fatal)
    let screenshotUrl: string | undefined;
    if (working.screenshot) {
      try {
        screenshotUrl = await client.uploadScreenshot(working.id, working.screenshot.dataUrl);
      } catch (e) {
        working = withError(working, `Screenshot upload failed: ${msg(e)}`);
      }
    }

    // 2. Sheets submission (non-fatal – local copy always saved)
    let submitted = false;
    try {
      const { rowId } = await client.submitToSheets(working, screenshotUrl);
      working = { ...working, sheetRowId: rowId, status: 'submitted' };
      submitted = true;
    } catch (e) {
      working = withError(working, `Google Sheets failed: ${msg(e)}. Saved locally.`);
      working = { ...working, status: 'failed' };
    }

    // 3. Persist locally regardless of integration outcome
    const { saveReport } = await import('../storage');
    await saveReport(working);
    await clearDraft(working.sessionId);

    // 4. End capture session
    try {
      await backgroundService.endSession(working.sessionId);
      if (tabIdRef.current) {
        await chrome.tabs.sendMessage(tabIdRef.current, { kind: 'END_SESSION' });
      }
    } catch {
      /* best effort */
    }

    setReport(working);
    setPhase('done');
    if (!submitted) setError('Report saved locally. Fix the highlighted issues and resubmit.');
  }, [report, settings]);

  /* ---------------- settings ---------------- */

  const persistSettings = useCallback(async (s: AppSettings) => {
    setSettings(s);
    await saveSettings(s);
  }, []);

  const reset = useCallback(() => {
    setReport(null);
    setPhase('idle');
    setError(null);
  }, []);

  return {
    phase,
    settings,
    report,
    busyMessage,
    error,
    startReport,
    recoverDraft,
    setScreenshot,
    retakeScreenshot,
    cancelReport,
    updateForm,
    finishEvidence,
    regenerateAi,
    submit,
    saveSettings: persistSettings,
    reset,
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function withError(r: BugReport, e: string): BugReport {
  return { ...r, errors: [...r.errors, e] };
}

/** Merge AI output into the editable form without destroying tester edits. */
function applyAi(r: BugReport, ai: BugReport['ai']): BugReport {
  if (!ai) return { ...r, ai };
  const form = { ...r.form };
  if (!form.title) form.title = ai.title;
  if (!form.description) form.description = ai.description || ai.summary;
  if (!form.stepsToReproduce.length) form.stepsToReproduce = ai.stepsToReproduce;
  if (!form.expectedResult) form.expectedResult = ai.expectedResult;
  if (!form.actualResult) form.actualResult = ai.actualResult;
  if (form.severity === 'Medium' && ai.severity) form.severity = ai.severity as Severity;
  if (form.priority === 'P2' && ai.priority) form.priority = ai.priority as Priority;
  return { ...r, ai, form };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function peekOrAssignId(): Promise<string> {
  // Assign the BUG-#### id up front so drafts show a stable identity.
  return nextBugId();
}

function placeholderEnv(): BugReport['environment'] {
  return {
    browserName: 'Chrome',
    browserVersion: 'unknown',
    operatingSystem: 'unknown',
    platform: navigator.platform ?? '',
    screenResolution: `${screen.width}x${screen.height}`,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio ?? 1,
    userAgent: navigator.userAgent,
    language: navigator.language,
  };
}
