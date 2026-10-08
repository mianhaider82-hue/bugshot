/**
 * Screenshot capture screen – offers visible-screen / full-page modes and a
 * "select area" flow (capture viewport first, then crop inside the editor).
 *
 * Documented Chrome API decision: `chrome.tabs.captureVisibleTab` requires the
 * target tab to be *visible*. Opening the popup does NOT hide the page (the
 * action popup doesn't steal tab visibility), so captures work directly — but
 * switching tabs while the popup is open can fail the capture with
 * "Cannot access a chrome:// URL" style errors. We surface a friendly retry.
 */

import { useState } from 'react';
import type { ScreenshotMode } from '../types';
import { backgroundService } from '../services/api';
import { Busy, ErrorNotice } from './ui';

interface Props {
  onCaptured: (dataUrl: string, mode: ScreenshotMode, width: number, height: number) => void;
  onCancel: () => void;
}

export function CaptureScreen({ onCaptured, onCancel }: Props): JSX.Element {
  const [busy, setBusy] = useState<ScreenshotMode | 'area' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function capture(mode: ScreenshotMode): Promise<void> {
    setBusy(mode);
    setError(null);
    try {
      const shot = await backgroundService.captureScreenshot(mode);
      onCaptured(shot.dataUrl, shot.mode, shot.width, shot.height);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (busy) return <Busy message={`Capturing ${busy === 'viewport' ? 'visible screen' : 'full page'}…`} />;

  return (
    <div className="content">
      <ErrorNotice message={error} />
      <div className="capture-options">
        <button className="btn primary" onClick={() => void capture('viewport')}>
          Visible screen
        </button>
        <button className="btn" onClick={() => void capture('fullpage')} title="Full-page capture uses CDP and may fall back to viewport">
          Full webpage
        </button>
      </div>
      <p className="meta" style={{ fontSize: 12, color: 'var(--text-dim)', margin: 0 }}>
        Tip: choose <strong>Visible screen</strong> then use the <strong>Crop</strong> tool to select an exact
        area. Full-page capture works where the browser allows it.
      </p>
      <div className="btn-row">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
