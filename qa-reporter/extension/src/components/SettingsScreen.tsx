/**
 * Settings screen – Account (Google), Sheets target, AI/backend status and
 * Privacy toggles (requirement #14).
 */

import { useEffect, useState } from 'react';
import type { AppSettings } from '../types';
import { BackendClient } from '../services/api';
import { listSheets, sheetsAuthUrl, type SheetInfo } from '../services/google';
import { Card, ErrorNotice } from './ui';

interface Props {
  settings: AppSettings;
  onSave: (s: AppSettings) => Promise<void>;
  onClose: () => void;
}

export function SettingsScreen({ settings, onSave, onClose }: Props): JSX.Element {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [sheets, setSheets] = useState<SheetInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void new BackendClient(settings.backendUrl).health().then(setBackendOk);
  }, [settings.backendUrl]);

  async function checkBackend(url: string): Promise<void> {
    setBackendOk(null);
    const ok = await new BackendClient(url).health();
    setBackendOk(ok);
  }

  async function loadSheets(): Promise<void> {
    setError(null);
    try {
      const list = await listSheets(draft.backendUrl);
      setSheets(list);
    } catch (e) {
      setSheets(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function privacy(key: keyof AppSettings['privacy'], label: string): JSX.Element {
    return (
      <div className="toggle-row">
        <span>{label}</span>
        <input
          type="checkbox"
          checked={draft.privacy[key]}
          onChange={(e) => setDraft({ ...draft, privacy: { ...draft.privacy, [key]: e.target.checked } })}
        />
      </div>
    );
  }

  async function save(): Promise<void> {
    await onSave(draft);
    setSaved(true);
    setTimeout(onClose, 350);
  }

  return (
    <div className="content">
      <ErrorNotice message={error} />

      <Card title="Account">
        <div className="toggle-row">
          <span>Google account</span>
          <button className="btn small" onClick={() => window.open(sheetsAuthUrl(draft.backendUrl), '_blank')}>
            Connect Google
          </button>
        </div>
        <div className="toggle-row">
          <span>Signed in as the Google account that authorized this backend connection.</span>
          <button className="btn small" onClick={() => void loadSheets()}>
            Check connection
          </button>
        </div>
      </Card>

      <Card title="Google Sheets">
        <div className="field">
          <label>Backend URL</label>
          <input
            type="text"
            value={draft.backendUrl}
            onChange={(e) => setDraft({ ...draft, backendUrl: e.target.value })}
            onBlur={(e) => void checkBackend(e.target.value)}
          />
        </div>
        <div className="toggle-row">
          <span>
            <span className={`status-dot ${backendOk ? 'ok' : backendOk === false ? 'bad' : ''}`} />
            Backend {backendOk === null ? 'checking…' : backendOk ? 'connected' : 'unreachable'}
          </span>
        </div>
        <div className="field">
          <label>Spreadsheet ID</label>
          <input
            type="text"
            placeholder="Paste spreadsheet ID or pick below"
            value={draft.sheetsSpreadsheetId}
            onChange={(e) => setDraft({ ...draft, sheetsSpreadsheetId: e.target.value })}
          />
        </div>
        {sheets && sheets.length > 0 && (
          <div className="field">
            <label>Your spreadsheets</label>
            <select
              onChange={(e) => {
                const s = sheets.find((x) => x.id === e.target.value);
                if (s) setDraft({ ...draft, sheetsSpreadsheetId: s.id });
              }}
              value={draft.sheetsSpreadsheetId}
            >
              <option value="">Select…</option>
              {sheets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Worksheet</label>
          <input
            type="text"
            value={draft.sheetsWorksheet}
            onChange={(e) => setDraft({ ...draft, sheetsWorksheet: e.target.value })}
          />
        </div>
      </Card>

      <Card title="AI">
        <div className="toggle-row">
          <span>AI bug analysis</span>
          <input type="checkbox" checked={draft.aiEnabled} onChange={(e) => setDraft({ ...draft, aiEnabled: e.target.checked })} />
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: 0 }}>
          The OpenAI key lives only on the backend. The extension never sees it.
        </p>
      </Card>

      <Card title="Privacy">
        {privacy('captureScreenshot', 'Screenshot collection')}
        {privacy('collectConsole', 'Console log collection')}
        {privacy('collectNetwork', 'Network / API collection')}
        {privacy('trackActions', 'User action tracking')}
        {privacy('redactEnabled', 'Automatic secret redaction (recommended)')}
        <div className="privacy-warning" style={{ marginTop: 8 }}>
          ⚠ Technical logs may contain sensitive information. Everything is reviewed by you before anything is
          uploaded, secrets are redacted automatically, and you can cancel a report at any time. Nothing is
          uploaded silently.
        </div>
      </Card>

      <div className="btn-row">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button className="btn primary" onClick={() => void save()}>
          {saved ? 'Saved ✓' : 'Save settings'}
        </button>
      </div>
    </div>
  );
}
