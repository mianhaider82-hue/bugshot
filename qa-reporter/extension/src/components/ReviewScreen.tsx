/**
 * Review screen – final stop before submission. Shows the (possibly AI-drafted)
 * report, all collected technical evidence, and lets the tester edit anything.
 * Requirement #12: the tester MUST be able to modify AI output before submit.
 */

import { useState } from 'react';
import type { BugReport, Priority, Severity } from '../types';
import { hhmmss } from '../utils/format';
import { Badge, Card, ErrorNotice } from './ui';

interface Props {
  report: BugReport;
  busy: string | null;
  error: string | null;
  onSubmit: () => void;
  onRegenerate: () => void;
  onSaveLocal: () => void;
  onCancel: () => void;
  onUpdateForm: (patch: Partial<BugReport['form']>) => void;
}

type Tab = 'report' | 'evidence';

const SEVERITIES: Severity[] = ['Critical', 'High', 'Medium', 'Low'];
const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];

export function ReviewScreen({
  report,
  busy,
  error,
  onSubmit,
  onRegenerate,
  onSaveLocal,
  onCancel,
  onUpdateForm,
}: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('report');
  const f = report.form;

  if (busy) return <div className="content"><ErrorNotice message={error} /><div className="busy">{busy}</div></div>;

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
        <>
          <Card title={`${report.id} · Bug report${report.ai ? ' · AI drafted' : ''}`}>
            {report.screenshot && (
              <img
                src={report.screenshot.dataUrl}
                alt="annotated screenshot"
                style={{ width: '100%', borderRadius: 8, border: '1px solid var(--border)', marginBottom: 10 }}
              />
            )}
            <div className="field">
              <label>Title</label>
              <input type="text" value={f.title} onChange={(e) => onUpdateForm({ title: e.target.value })} />
            </div>
            <div className="btn-row" style={{ marginBottom: 10 }}>
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
              <textarea value={f.description} onChange={(e) => onUpdateForm({ description: e.target.value })} />
            </div>
            <div className="field">
              <label>Steps to reproduce</label>
              {f.stepsToReproduce.map((step, i) => (
                <input
                  key={i}
                  type="text"
                  value={step}
                  style={{ marginBottom: 4 }}
                  onChange={(e) => {
                    const next = [...f.stepsToReproduce];
                    next[i] = e.target.value;
                    onUpdateForm({ stepsToReproduce: next });
                  }}
                />
              ))}
            </div>
            <div className="field">
              <label>Expected result</label>
              <textarea value={f.expectedResult} onChange={(e) => onUpdateForm({ expectedResult: e.target.value })} />
            </div>
            <div className="field">
              <label>Actual result</label>
              <textarea value={f.actualResult} onChange={(e) => onUpdateForm({ actualResult: e.target.value })} />
            </div>
            {report.ai?.possibleCause && (
              <div className="notice info">
                <strong>Possible cause (AI hypothesis, not confirmed):</strong> {report.ai.possibleCause}
              </div>
            )}
          </Card>

          <div className="btn-row">
            <button className="btn" onClick={onCancel}>Cancel</button>
            <button className="btn" onClick={onSaveLocal}>Save locally</button>
            <button className="btn" onClick={onRegenerate} disabled={!report.ai}>↻ Regenerate</button>
            <button className="btn primary" onClick={onSubmit}>Submit → Sheets</button>
          </div>
        </>
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
