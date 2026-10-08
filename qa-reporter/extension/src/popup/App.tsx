/**
 * Popup root – routes between the workflow phases owned by useReportSession.
 *
 *   idle → capture → annotate → form → (evidence/analyzing) → review → done
 *   + settings overlay + draft recovery banner (requirement #19)
 */

import { useEffect, useState } from 'react';
import { useReportSession } from '../hooks/useReportSession';
import type { BugReport, ScreenshotData } from '../types';
import { listDrafts, listReports, saveReport, clearDraft } from '../storage';
import { backgroundService } from '../services/api';
import { CaptureScreen } from '../components/CaptureScreen';
import { AnnotationEditor } from '../components/AnnotationEditor';
import { ReportFormScreen } from '../components/ReportFormScreen';
import { ReviewScreen } from '../components/ReviewScreen';
import { SettingsScreen } from '../components/SettingsScreen';
import { Badge, Card, ErrorNotice, StatusBadge } from '../components/ui';

type Screen = 'main' | 'settings';

export function App(): JSX.Element {
  const s = useReportSession();
  const [screen, setScreen] = useState<Screen>('main');
  const [reports, setReports] = useState<BugReport[]>([]);
  const [draftCount, setDraftCount] = useState(0);

  // Pending raw capture awaiting annotation (kept in popup memory only;
  // nothing is stored until the tester clicks "Use screenshot").
  const [pendingShot, setPendingShot] = useState<ScreenshotData | null>(null);

  const refreshLists = async (): Promise<void> => {
    setReports(await listReports());
    setDraftCount((await listDrafts()).length);
  };

  useEffect(() => {
    void refreshLists();
  }, [s.phase]);

  /* ---------- header ---------- */
  const inSession = !['idle', 'done'].includes(s.phase);
  const header = (
    <div className="header">
      <div className="brand">
        <img src="/icons/icon-48.png" alt="" /> QA Reporter
      </div>
      {inSession && <div className="rec">REC</div>}
    </div>
  );

  /* ---------- settings overlay ---------- */
  if (screen === 'settings') {
    return (
      <div className="app">
        {header}
        <SettingsScreen
          settings={s.settings}
          onSave={async (next) => {
            await s.saveSettings(next);
          }}
          onClose={() => setScreen('main')}
        />
      </div>
    );
  }

  /* ---------- workflow screens ---------- */
  let body: JSX.Element;

  switch (s.phase) {
    case 'capturing':
      body = (
        <CaptureScreen
          onCancel={() => void s.cancelReport()}
          onCaptured={(dataUrl, mode, width, height) => {
            setPendingShot({ dataUrl, mode, width, height, capturedAt: new Date().toISOString() });
          }}
        />
      );
      break;

    case 'annotating':
      body = pendingShot ? (
        <div className="content">
          <AnnotationEditor
            dataUrl={pendingShot.dataUrl}
            mode={pendingShot.mode}
            onRetake={() => setPendingShot(null)}
            onCancel={() => void s.cancelReport()}
            onSave={(dataUrl, width, height) => {
              s.setScreenshot({ ...pendingShot, dataUrl, width, height });
              setPendingShot(null);
            }}
          />
        </div>
      ) : (
        <CaptureScreen
          onCancel={() => void s.cancelReport()}
          onCaptured={(dataUrl, mode, width, height) =>
            setPendingShot({ dataUrl, mode, width, height, capturedAt: new Date().toISOString() })
          }
        />
      );
      break;

    case 'evidence':
      body = s.report ? (
        <ReportFormScreen
          form={s.report.form}
          busy={s.busyMessage}
          error={s.error}
          onChange={s.updateForm}
          onCancel={() => void s.cancelReport()}
          onContinue={() => void s.finishEvidence()}
        />
      ) : (
        <div className="empty">No active report.</div>
      );
      break;

    case 'analyzing':
      body = <div className="content"><ErrorNotice message={s.error} /><div className="busy">{s.busyMessage ?? 'Working…'}</div></div>;
      break;

    case 'review':
      body = s.report ? (
        <ReviewScreen
          report={s.report}
          busy={s.busyMessage}
          error={s.error}
          onSubmit={() => void s.submit()}
          onRegenerate={() => void s.regenerateAi()}
          onSaveLocal={async () => {
            if (!s.report) return;
            await saveReport({ ...s.report, status: 'draft' });
            await clearDraft(s.report.sessionId);
            await backgroundService.endSession(s.report.sessionId);
            s.reset();
            void refreshLists();
          }}
          onCancel={() => void s.cancelReport()}
          onUpdateForm={s.updateForm}
        />
      ) : (
        <div className="empty">No active report.</div>
      );
      break;

    case 'submitting':
      body = <div className="content"><div className="busy">{s.busyMessage ?? 'Submitting…'}</div></div>;
      break;

    case 'done':
      body = (
        <div className="content">
          <Card title="Done">
            <p style={{ fontSize: 13 }}>
              {s.report?.status === 'submitted'
                ? `${s.report.id} submitted to Google Sheets ✓`
                : `${s.report?.id ?? 'Report'} saved locally.`}
            </p>
            {s.error && <ErrorNotice message={s.error} />}
            <button className="btn primary big" onClick={s.reset}>
              New report
            </button>
          </Card>
        </div>
      );
      break;

    default:
      body = (
        <div className="content">
          <ErrorNotice message={s.error} />
          {draftCount > 0 && (
            <DraftBanner onRecover={s.recoverDraft} onDiscard={async () => {
              const drafts = await listDrafts();
              for (const d of drafts) await clearDraft(d.sessionId);
              void refreshLists();
            }} />
          )}
          <button className="btn primary big" onClick={() => void s.startReport()}>
            + Report Bug
          </button>
          <Card title="Recent reports">
            {reports.length === 0 && <div className="empty">No reports yet.</div>}
            {reports.slice(0, 6).map((r) => (
              <div key={r.id} className="report-item">
                <div>
                  <div className="meta">{r.id}</div>
                  <div className="title">{r.form.title || '(untitled)'}</div>
                  <StatusBadge status={r.status} />
                </div>
                <Badge severity={r.form.severity} />
              </div>
            ))}
          </Card>
        </div>
      );
  }

  return (
    <div className="app">
      {header}
      {body}
      {!inSession && s.phase === 'idle' && (
        <div className="footer">
          <button className="btn small" onClick={() => setScreen('settings')}>
            Settings
          </button>
          <span className="meta" style={{ fontSize: 11, color: 'var(--text-dim)', alignSelf: 'center' }}>
            v0.1.0
          </span>
        </div>
      )}
    </div>
  );
}

/** Draft-recovery banner: unfinished sessions survive browser restarts. */
function DraftBanner({
  onRecover,
  onDiscard,
}: {
  onRecover: (sessionId: string) => Promise<void>;
  onDiscard: () => Promise<void>;
}): JSX.Element {
  const [drafts, setDrafts] = useState<BugReport[]>([]);
  useEffect(() => {
    void listDrafts().then(setDrafts);
  }, []);
  if (!drafts.length) return <></>;
  const d = drafts[0];
  return (
    <div className="notice info" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
      <span>
        Unfinished report <strong>{d.id}</strong> found ({d.form.title || 'no title'}).
      </span>
      <span style={{ display: 'flex', gap: 6 }}>
        <button className="btn small primary" onClick={() => void onRecover(d.sessionId)}>
          Recover
        </button>
        <button className="btn small" onClick={() => void onDiscard()}>
          Discard
        </button>
      </span>
    </div>
  );
}
