/**
 * Bug report form screen – shown after the screenshot is confirmed, while the
 * session keeps collecting evidence in the background. Pressing "Continue"
 * snapshots console/network/action buffers + page info and (optionally) runs
 * AI analysis.
 */

import type { BugReportForm as FormValues, Priority, Severity } from '../types';
import { Card, ErrorNotice } from './ui';

interface Props {
  form: FormValues;
  onChange: (patch: Partial<FormValues>) => void;
  onContinue: () => void;
  onCancel: () => void;
  busy: string | null;
  error: string | null;
}

const SEVERITIES: Severity[] = ['Critical', 'High', 'Medium', 'Low'];
const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];

export function ReportFormScreen({ form, onChange, onContinue, onCancel, busy, error }: Props): JSX.Element {
  if (busy) {
    return (
      <div className="content">
        <ErrorNotice message={error} />
        <div className="busy">{busy}</div>
      </div>
    );
  }

  return (
    <div className="content">
      <ErrorNotice message={error} />
      <Card title="Bug details">
        <div className="field">
          <label htmlFor="title">Problem title *</label>
          <input
            id="title"
            type="text"
            value={form.title}
            placeholder="e.g. Checkout payment fails with 500"
            onChange={(e) => onChange({ title: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="desc">Description</label>
          <textarea
            id="desc"
            value={form.description}
            placeholder="What went wrong? (AI can draft this for you)"
            onChange={(e) => onChange({ description: e.target.value })}
          />
        </div>
        <div className="btn-row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="sev">Severity</label>
            <select id="sev" value={form.severity} onChange={(e) => onChange({ severity: e.target.value as Severity })}>
              {SEVERITIES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="pri">Priority</label>
            <select id="pri" value={form.priority} onChange={(e) => onChange({ priority: e.target.value as Priority })}>
              {PRIORITIES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      <Card title="Steps to reproduce">
        {form.stepsToReproduce.map((step, i) => (
          <div className="field" key={i}>
            <input
              type="text"
              value={step}
              onChange={(e) => {
                const next = [...form.stepsToReproduce];
                next[i] = e.target.value;
                onChange({ stepsToReproduce: next });
              }}
            />
          </div>
        ))}
        <button
          className="btn small"
          onClick={() => onChange({ stepsToReproduce: [...form.stepsToReproduce, ''] })}
        >
          + Add step
        </button>
      </Card>

      <Card title="Expected vs actual">
        <div className="field">
          <label htmlFor="exp">Expected result</label>
          <textarea id="exp" value={form.expectedResult} onChange={(e) => onChange({ expectedResult: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="act">Actual result</label>
          <textarea id="act" value={form.actualResult} onChange={(e) => onChange({ actualResult: e.target.value })} />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="notes">Additional notes</label>
          <textarea id="notes" value={form.additionalNotes} onChange={(e) => onChange({ additionalNotes: e.target.value })} />
        </div>
      </Card>

      <div className="btn-row">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" onClick={onContinue}>
          Collect evidence &amp; analyze →
        </button>
      </div>
    </div>
  );
}
