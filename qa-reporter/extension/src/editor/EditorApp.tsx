/**
 * Editor tab – opened by the background worker right after a capture.
 *
 *   1. Edit:   annotate the screenshot + describe the problem / wanted change
 *   2. Review: AI-drafted title, description, steps, expected result (editable)
 *   3. Export: Google Sheets, Markdown, PDF, JSON
 */

import { useEffect, useRef } from 'react';
import { AnnotationEditor, type AnnotationEditorHandle } from '../components/AnnotationEditor';
import { ReviewScreen, type ExportAction } from '../components/ReviewScreen';
import { Busy, Card, ErrorNotice } from '../components/ui';
import { copyMarkdown, downloadJson, downloadPdf } from '../services/export';
import type { BugReport, ReportType } from '../types';
import { REPORT_TYPE_LABELS } from '../types';
import { useEditorSession } from './useEditorSession';

const sessionId = new URLSearchParams(location.search).get('session');

const NOTE_PLACEHOLDER: Record<ReportType, string> = {
  bug: 'What went wrong? e.g. "Clicking Pay shows a blank screen instead of the confirmation"',
  design: 'What should change? e.g. "Button text is cut off on small screens, make it wrap"',
  improvement: 'What would make this better? e.g. "Remember the last selected filter"',
};

export function EditorApp(): JSX.Element {
  const s = useEditorSession(sessionId);
  const editorRef = useRef<AnnotationEditorHandle>(null);
  const r = s.report;

  useEffect(() => {
    if (r) document.title = `${r.id} – QA Reporter`;
  }, [r?.id]);

  // Warn before closing the tab with unsaved annotations.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (s.phase === 'editing' && editorRef.current?.isDirty()) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [s.phase]);

  async function onExport(action: ExportAction): Promise<void> {
    if (!r) return;
    s.setNotice(null);
    try {
      if (action === 'sheets') return await s.submitToSheets();
      if (action === 'local') return await s.saveLocal();
      if (action === 'markdown') {
        await copyMarkdown(r);
        s.setNotice('Copied report as Markdown.');
      } else if (action === 'json') downloadJson(r);
      else await downloadPdf(r);
    } catch (e) {
      s.setNotice(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let body: JSX.Element;
  switch (s.phase) {
    case 'loading':
      body = <Busy message="Loading report…" />;
      break;

    case 'missing':
      body = (
        <div className="editor-center">
          <Card title="Report not found">
            <p className="dim">This report was already saved or discarded. Click the extension icon to take a new screenshot.</p>
            <button className="btn" onClick={() => window.close()}>Close tab</button>
          </Card>
        </div>
      );
      break;

    case 'editing':
      body = r ? (
        <EditStep
          report={r}
          editorRef={editorRef}
          error={s.error}
          aiEnabled={s.settings.aiEnabled}
          onUpdateForm={s.updateForm}
          onDiscard={() => {
            if (confirm('Discard this report?')) void s.discard();
          }}
          onAnalyze={() => void s.analyze(editorRef.current?.exportImage() ?? null)}
        />
      ) : (
        <></>
      );
      break;

    case 'analyzing':
      body = (
        <div className="editor-center">
          <Busy message="AI is analyzing the screenshot, your note, console and network logs…" />
        </div>
      );
      break;

    case 'submitting':
      body = (
        <div className="editor-center">
          <Busy message="Uploading screenshot and adding a row to Google Sheets…" />
        </div>
      );
      break;

    case 'review':
      body = r ? (
        <ReviewScreen
          report={r}
          error={s.error}
          aiEnabled={s.settings.aiEnabled}
          onExport={(a) => void onExport(a)}
          onRegenerate={() => void s.regenerateAi()}
          onBack={s.backToEdit}
          onUpdateForm={s.updateForm}
        />
      ) : (
        <></>
      );
      break;

    case 'done':
      body = (
        <div className="editor-center">
          <Card title="Done">
            <p>{s.notice ?? 'Report saved.'}</p>
            {r?.status === 'submitted' && r.errors.length > 0 && <ErrorNotice message={r.errors.join(' ')} />}
            <div className="export-grid" style={{ marginBottom: 10 }}>
              <button className="btn" onClick={() => r && void copyMarkdown(r).then(() => s.setNotice('Copied report as Markdown.'))}>
                Copy as Markdown
              </button>
              <button className="btn" onClick={() => r && void downloadPdf(r)}>Download PDF</button>
            </div>
            <button className="btn primary big" onClick={() => window.close()}>
              Close tab
            </button>
          </Card>
        </div>
      );
      break;
  }

  return (
    <div className="editor-app">
      <header className="header">
        <div className="brand">
          <img src="/icons/icon-48.png" alt="" /> QA Reporter
          {r && <span className="dim header-id">{r.id}</span>}
        </div>
        {r && s.phase !== 'missing' && <Steps phase={s.phase} />}
        {r && (
          <a className="header-url dim" href={r.page.url} target="_blank" rel="noreferrer" title={r.page.url}>
            {r.page.title || r.page.url}
          </a>
        )}
      </header>
      {s.notice && s.phase !== 'done' && (
        <div className="notice info toast" role="status">
          {s.notice}
          <button className="tool-btn" onClick={() => s.setNotice(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
      <main className="editor-main">{body}</main>
    </div>
  );
}

function Steps({ phase }: { phase: string }): JSX.Element {
  const current = phase === 'editing' ? 0 : phase === 'done' ? 2 : 1;
  return (
    <ol className="steps-bar">
      {['Edit screenshot', 'AI report', 'Export'].map((label, i) => (
        <li key={label} className={i === current ? 'active' : i < current ? 'past' : ''}>
          {i + 1}. {label}
        </li>
      ))}
    </ol>
  );
}

function EditStep({
  report,
  editorRef,
  error,
  aiEnabled,
  onUpdateForm,
  onDiscard,
  onAnalyze,
}: {
  report: BugReport;
  editorRef: React.RefObject<AnnotationEditorHandle>;
  error: string | null;
  aiEnabled: boolean;
  onUpdateForm: (patch: Partial<BugReport['form']>) => void;
  onDiscard: () => void;
  onAnalyze: () => void;
}): JSX.Element {
  const f = report.form;
  const type = f.reportType ?? 'bug';
  const consoleErrors = report.consoleEntries.filter((c) => c.type !== 'info' && c.type !== 'warn').length;
  const failedRequests = report.networkEntries.filter((n) => n.failed || n.status >= 400).length;

  return (
    <div className="edit-grid">
      <section className="edit-canvas">
        {report.screenshot ? (
          <AnnotationEditor ref={editorRef} dataUrl={report.screenshot.dataUrl} />
        ) : (
          <div className="empty">No screenshot in this report.</div>
        )}
      </section>

      <aside className="edit-panel">
        <ErrorNotice message={error} />
        <Card title="What are you reporting?">
          <div className="type-chips" role="radiogroup">
            {(Object.keys(REPORT_TYPE_LABELS) as ReportType[]).map((t) => (
              <button
                key={t}
                role="radio"
                aria-checked={type === t}
                className={`tool-btn ${type === t ? 'active' : ''}`}
                onClick={() => onUpdateForm({ reportType: t })}
              >
                {REPORT_TYPE_LABELS[t]}
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor="note">Describe the problem or the update you want</label>
            <textarea
              id="note"
              rows={6}
              autoFocus
              value={f.additionalNotes}
              placeholder={NOTE_PLACEHOLDER[type]}
              onChange={(e) => onUpdateForm({ additionalNotes: e.target.value })}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="expected">Expected result (optional)</label>
            <textarea
              id="expected"
              rows={2}
              value={f.expectedResult}
              placeholder="What should happen instead?"
              onChange={(e) => onUpdateForm({ expectedResult: e.target.value })}
            />
          </div>
        </Card>

        <Card title="Attached automatically">
          <div className="evidence-count">
            <span className={`pill ${consoleErrors ? 'bad' : ''}`}>{consoleErrors} console errors</span>
            <span className={`pill ${failedRequests ? 'bad' : ''}`}>{failedRequests} failed requests</span>
            <span className="pill">{report.networkEntries.length} requests</span>
            <span className="pill">{report.actions.length} actions</span>
          </div>
          <p className="dim small-text">
            Page URL, browser and screen size are included too. Passwords, tokens and card numbers are redacted before
            anything is sent.
          </p>
          {report.errors.map((e, i) => (
            <div key={i} className="notice info" style={{ marginTop: 6 }}>{e}</div>
          ))}
        </Card>

        <div className="btn-row">
          <button className="btn" onClick={onDiscard}>Discard</button>
          <button className="btn primary" onClick={onAnalyze}>
            {aiEnabled ? 'Save & analyze with AI →' : 'Save & continue →'}
          </button>
        </div>
      </aside>
    </div>
  );
}
