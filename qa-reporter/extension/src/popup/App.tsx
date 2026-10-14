/**
 * Popup root – a quick launcher.
 *
 *   click icon → "Visible screen" / "Full page" → editor opens in a new tab
 *
 * Opening the popup connects a Port; the background attaches the debugger to
 * the active tab while it is open (extra network/log evidence) and detaches
 * when the popup closes. Unfinished reports can be reopened from here.
 */

import { useEffect, useState } from 'react';
import type { AppSettings, BugReport, ScreenshotMode } from '../types';
import { DEFAULT_SETTINGS, POPUP_PORT } from '../types';
import { clearDraft, listDrafts, listReports, loadSettings, saveSettings } from '../storage';
import { backgroundService } from '../services/api';
import { SettingsScreen } from '../components/SettingsScreen';
import { Badge, Busy, Card, ErrorNotice, StatusBadge } from '../components/ui';

type Screen = 'main' | 'settings';

export function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>('main');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [reports, setReports] = useState<BugReport[]>([]);
  const [drafts, setDrafts] = useState<BugReport[]>([]);
  const [busy, setBusy] = useState<ScreenshotMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshLists = async (): Promise<void> => {
    setReports(await listReports());
    setDrafts(await listDrafts());
  };

  useEffect(() => {
    const port = chrome.runtime.connect({ name: POPUP_PORT });
    void loadSettings().then(setSettings);
    void refreshLists();
    return () => port.disconnect();
  }, []);

  async function capture(mode: ScreenshotMode): Promise<void> {
    setBusy(mode);
    setError(null);
    try {
      await backgroundService.captureAndOpenEditor(mode);
      window.close(); // the editor tab has the rest of the flow
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  function openDraft(d: BugReport): void {
    void chrome.tabs.create({
      url: chrome.runtime.getURL(`editor/editor.html?session=${encodeURIComponent(d.sessionId)}`),
    });
    window.close();
  }

  const header = (
    <div className="header">
      <div className="brand">
        <img src="/icons/icon-48.png" alt="" /> QA Reporter
      </div>
    </div>
  );

  if (screen === 'settings') {
    return (
      <div className="app">
        {header}
        <SettingsScreen
          settings={settings}
          onSave={async (next) => {
            setSettings(next);
            await saveSettings(next);
          }}
          onClose={() => setScreen('main')}
        />
      </div>
    );
  }

  return (
    <div className="app">
      {header}
      <div className="content">
        <ErrorNotice message={error} />
        {busy ? (
          <Busy message={`Capturing ${busy === 'viewport' ? 'visible screen' : 'full page'}…`} />
        ) : (
          <>
            <div className="capture-options">
              <button className="btn primary big" onClick={() => void capture('viewport')}>
                Visible screen
              </button>
              <button className="btn big" onClick={() => void capture('fullpage')}>
                Full page
              </button>
            </div>
            <p className="meta" style={{ fontSize: 12, color: 'var(--text-dim)', margin: 0 }}>
              The screenshot opens in a new tab where you can mark it up and describe the problem. Recent console
              errors and network requests are attached automatically.
            </p>
          </>
        )}

        {drafts.length > 0 && (
          <Card title="Unfinished">
            {drafts.slice(0, 3).map((d) => (
              <div key={d.sessionId} className="report-item">
                <div>
                  <div className="meta">{d.id}</div>
                  <div className="title">{d.form.title || d.page.title || '(untitled)'}</div>
                </div>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button className="btn small primary" onClick={() => openDraft(d)}>Open</button>
                  <button
                    className="btn small"
                    onClick={async () => {
                      await clearDraft(d.sessionId);
                      void refreshLists();
                    }}
                  >
                    Discard
                  </button>
                </span>
              </div>
            ))}
          </Card>
        )}

        <Card title="Recent reports">
          {reports.length === 0 && <div className="empty">No reports yet.</div>}
          {reports.slice(0, 5).map((r) => (
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
      <div className="footer">
        <button className="btn small" onClick={() => setScreen('settings')}>
          Settings
        </button>
        <span className="meta" style={{ fontSize: 11, color: 'var(--text-dim)', alignSelf: 'center' }}>
          v0.2.0
        </span>
      </div>
    </div>
  );
}
