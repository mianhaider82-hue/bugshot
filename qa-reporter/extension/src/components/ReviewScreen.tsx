/**
 * Review screen – final stop before export. Shows the (possibly AI-drafted)
 * report, all collected technical evidence, and lets the tester edit anything.
 * Requirement #12: the tester MUST be able to modify AI output before submit.
 */

import { useState } from 'react';
import type { BugReport, Priority, ReportType, Severity } from '../types';
import { REPORT_TYPE_LABELS } from '../types';
import { hhmmss } from '../utils/format';
import { Badge, Card, ErrorNotice } from './ui';

export type ExportAction = 'sheets' | 'markdown' | 'json' | 'pdf' | 'local';

interface Props {
  report: BugReport;
  error: string | null;
  aiEnabled: boolean;
  onExport: (action: ExportAction) => void;
  onRegenerate: () => void;
  onBack: () => void;
  onUpdateForm: (patch: Partial<BugReport['form']>) => void;
}

type Tab = 'report' | 'evidence';

const SEVERITIES: Severity[] = ['Critical', 'High', 'Medium', 'Low'];
const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];

export function ReviewScreen({
  report,
  error,
  aiEnabled,
  onExport,
  onRegenerate,
  onBack,
  onUpdateForm,
}: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('report');
  const f = report.form;

  const consoleErrors = report.consoleEntries.filter((c) => c.type === 'error' || c.type === 'exception' || c.type === 'rejection');
  const apiErrors = report.networkEntries.filter((n) => n.failed || n.status >= 400);

  return (
    <div className="content">
      <ErrorNotice message={error} />
      {report.errors.length > 0 && (
        <div className="notice info">
          Some integrations degraded during capture — the report is still safe locally:
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {report.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="tool-row" style={{ margin: 0 }}>
        <button className={`tool-btn ${tab === 'report' ? 'active' : ''}`} onClick={() => setTab('report')}>
          Report
        </button>
        <button className={`tool-btn ${tab === 'evidence' ? 'active' : ''}`} onClick={() => setTab('evidence')}>
          Evidence ({report.consoleEntries.length + report.networkEntries.length + report.actions.length})
        </button>
      </div>

      {tab === 'report' ? (
        <div className="review-grid">
          <div>
            {report.screenshot && (
              <img className="review-shot" src={report.screenshot.dataUrl} alt="annotated screenshot" />
            )}
            <button className="btn small" style={{ marginTop: 8 }} onClick={onBack}>
              ← Edit screenshot &amp; note
            </button>
          </div>

          <div className="review-fields">
            <Card title={`${report.id} · ${REPORT_TYPE_LABELS[f.reportType ?? 'bug']}${report.ai ? ' · AI drafted' : ''}`}>
              <div className="field">
                <label>Title</label>
                <input type="text" value={f.title} onChange={(e) => onUpdateForm({ title: e.target.value })} />
              </div>
              <div className="btn-row" style={{ marginBottom: 10 }}>
                <select value={f.reportType ?? 'bug'} onChange={(e) => onUpdateForm({ reportType: e.target.value as ReportType })} className="btn" style={{ flex: 1.4 }}>
                  {(Object.keys(REPORT_TYPE_LABELS) as ReportType[]).map((t) => (
                    <option key={t} value={t}>{REPORT_TYPE_LABELS[t]}</option>
                  ))}
                </select>
                <select value={f.severity} onChange={(e) => onUpdateForm({ severity: e.target.value as Severity })} className="btn" style={{ flex: 1 }}>
                  {SEVERITIES.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <select value={f.priority} onChange={(e) => onUpdateForm({ priority: e.target.value as Priority })} className="btn" style={{ flex: 1 }}>
                  {PRIORITIES.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
                <Badge severity={f.severity} />
              </div>
              <div className="field">
                <label>Description</label>
                <textarea rows={4} value={f.description} onChange={(e) => onUpdateForm({ description: e.target.value })} />
              </div>
              <div className="field">
                <label>Steps to reproduce</label>
                {f.stepsToReproduce.map((step, i) => (
                  <div key={i} className="step-row">
                    <span className="step-num">{i + 1}.</span>
                    <input
                      type="text"
                      value={step}
                      onChange={(e) => {
                        const next = [...f.stepsToReproduce];
                        next[i] = e.target.value;
                        onUpdateForm({ stepsToReproduce: next });
                      }}
                    />
                    <button
                      className="tool-btn"
                      aria-label={`Remove step ${i + 1}`}
                      onClick={() => onUpdateForm({ stepsToReproduce: f.stepsToReproduce.filter((_, j) => j !== i) })}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => onUpdateForm({ stepsToReproduce: [...f.stepsToReproduce, ''] })}>
                  + Add step
                </button>
              </div>
              <div className="field">
                <label>Expected result</label>
                <textarea value={f.expectedResult} onChange={(e) => onUpdateForm({ expectedResult: e.target.value })} />
              </div>
              <div className="field">
                <label>Actual result</label>
                <textarea value={f.actualResult} onChange={(e) => onUpdateForm({ actualResult: e.target.value })} />
              </div>
              <div className="field">
                <label>Tester notes</label>
                <textarea value={f.additionalNotes} onChange={(e) => onUpdateForm({ additionalNotes: e.target.value })} />
              </div>
              {report.ai?.possibleCause && (
                <div className="notice info">
                  <strong>Possible cause (AI hypothesis, not confirmed):</strong> {report.ai.possibleCause}
                </div>
              )}
            </Card>

            <Card title="Export">
              <div className="export-grid">
                <button className="btn primary" onClick={() => onExport('sheets')}>Add to Google Sheets</button>
                <button className="btn" onClick={() => onExport('markdown')}>Copy as Markdown</button>
                <button className="btn" onClick={() => onExport('pdf')}>Download PDF</button>
                <button className="btn" onClick={() => onExport('json')}>Download JSON</button>
              </div>
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button className="btn small" onClick={onRegenerate} disabled={!aiEnabled}>↻ Regenerate AI draft</button>
                <button className="btn small" onClick={() => onExport('local')}>Save &amp; close</button>
              </div>
            </Card>
          </div>
        </div>
      ) : (
        <>
          <Card title="Page & environment">
            <div className="review-section">
              <h4>URL</h4>
              <div className="value" style={{ wordBreak: 'break-all' }}>{report.page.url}</div>
            </div>
            <div className="review-section">
              <h4>Environment</h4>
              <div className="value">
                {report.environment.browserName} {report.environment.browserVersion} · {report.environment.operatingSystem}
                <br />
                Screen {report.environment.screenResolution} · Viewport {report.environment.viewportWidth}×
                {report.environment.viewportHeight} · DPR {report.environment.devicePixelRatio}
              </div>
            </div>
          </Card>

          <div className="evidence-count">
            <span className="pill">{consoleErrors.length} console errors</span>
            <span className="pill">{apiErrors.length} API errors</span>
            <span className="pill">{report.actions.length} actions</span>
          </div>

          <Card title="Console">
            <div className="evidence-list">
              {report.consoleEntries.length === 0 && <div className="row">No console entries captured.</div>}
              {report.consoleEntries.slice(-30).map((c, i) => (
                <div key={i} className={`row ${c.type === 'error' || c.type === 'exception' ? 'error' : c.type === 'warn' ? 'warn' : ''}`}>
                  [{hhmmss(c.timestamp)}] {c.type.toUpperCase()} {c.message}
                  {c.source ? ` — ${c.source}${c.line ? `:${c.line}` : ''}` : ''}
                </div>
              ))}
            </div>
          </Card>

          <Card title="Network">
            <div className="evidence-list">
              {report.networkEntries.length === 0 && <div className="row">No network entries captured.</div>}
              {report.networkEntries.slice(-30).map((n, i) => (
                <div key={i} className={`row ${n.failed || n.status >= 400 ? 'error' : ''}`}>
                  {n.method} {shortUrl(n.url)} → {n.failed ? `FAILED (${n.errorText})` : n.status}{' '}
                  {n.durationMs != null ? `${n.durationMs}ms` : ''}
                </div>
              ))}
            </div>
          </Card>

          <Card title="User actions">
            <div className="evidence-list">
              {report.actions.length === 0 && <div className="row">No actions tracked.</div>}
              {report.actions.slice(-30).map((a, i) => (
                <div key={i} className="row">
                  [{hhmmss(a.timestamp)}] {a.label}
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname.length > 28 ? `${u.pathname.slice(0, 28)}…` : u.pathname;
    return `${u.host}${p}`;
  } catch {
    return url.slice(0, 40);
  }
}
