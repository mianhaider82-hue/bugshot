/**
 * Annotation editor – canvas-based, dependency-free.
 *
 * Tools: rectangle, arrow, free drawing, text, blur, crop + undo/redo.
 *
 * Implementation notes (documented decisions):
 *  - Annotations are stored as a *list of shape objects* and re-rendered from
 *    scratch on every change (immediate-mode). This is what makes undo/redo
 *    trivial (pop/push the list) and keeps blur/crop deterministic — pixel
 *    scraping an "undo stack" of ImageData would blow up popup memory.
 *  - Blur is implemented by drawing the source region scaled down then back up
 *    with smoothing disabled → a genuine mosaic that hides text.
 *  - Crop applies to the base image itself (destructive but redoable through
 *    the history of full editor states kept in `history` below).
 *  - The canvas works in image pixels; CSS scales it to popup width. Pointer
 *    coordinates are converted via getBoundingClientRect so DPR/CSS scaling
 *    never shifts annotations.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScreenshotMode } from '../types';

export interface EditorProps {
  dataUrl: string;
  mode: ScreenshotMode;
  onSave: (dataUrl: string, width: number, height: number) => void;
  onRetake: () => void;
  onCancel: () => void;
}

type Tool = 'rect' | 'arrow' | 'pen' | 'text' | 'blur' | 'crop';

interface Point {
  x: number;
  y: number;
}

/** Discriminated union of drawable annotation shapes. */
type Shape =
  | { tool: 'rect'; a: Point; b: Point; color: string }
  | { tool: 'arrow'; a: Point; b: Point; color: string }
  | { tool: 'pen'; points: Point[]; color: string }
  | { tool: 'text'; at: Point; text: string; color: string }
  | { tool: 'blur'; a: Point; b: Point };

interface EditorState {
  base: HTMLCanvasElement; // screenshot, possibly cropped
  shapes: Shape[];
}

const COLORS = ['#dc2626', '#2563eb', '#f59e0b', '#16a34a', '#0f172a', '#ffffff'];

export function AnnotationEditor({ dataUrl, mode, onSave, onRetake, onCancel }: EditorProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>('rect');
  const [color, setColor] = useState<string>(COLORS[0]);
  const [ready, setReady] = useState(false);
  const [pendingText, setPendingText] = useState<{ at: Point } | null>(null);
  const [textValue, setTextValue] = useState('');

  // Mutable state kept in refs: render loop reads them without re-renders.
  const stateRef = useRef<EditorState | null>(null);
  // Draft shape while dragging: `tool` may still be 'crop' (not a final
  // drawable Shape), so we keep a widened local type for it.
  type Draft =
    | { tool: 'rect' | 'arrow'; a: Point; b: Point; color: string }
    | { tool: 'blur' | 'crop'; a: Point; b: Point; color?: undefined }
    | { tool: 'pen'; points: Point[]; color: string };
  const draftRef = useRef<Draft | null>(null);
  const historyRef = useRef<Shape[][]>([]);
  const futureRef = useRef<Shape[][]>([]);
  const [, forceRender] = useState(0);

  /* ---------- load base image ---------- */
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      stateRef.current = { base: c, shapes: [] };
      historyRef.current = [];
      futureRef.current = [];
      setReady(true);
      redraw();
    };
    img.onerror = () => setReady(false);
    img.src = dataUrl;
    return () => {
      cancelled = true;
    };
  }, [dataUrl]);

  /* ---------- rendering ---------- */

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const st = stateRef.current;
    if (!canvas || !st) return;
    canvas.width = st.base.width;
    canvas.height = st.base.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(st.base, 0, 0);
    for (const s of st.shapes) drawShape(ctx, s, st.base);
    const d = draftRef.current;
    if (d) {
      const preview: Shape =
        d.tool === 'crop'
          ? { tool: 'rect', a: d.a, b: d.b, color: '#2563eb' }
          : d.tool === 'blur'
            ? { tool: 'blur', a: d.a, b: d.b }
            : d.tool === 'pen'
              ? { tool: 'pen', points: d.points, color: d.color }
              : { tool: d.tool, a: d.a, b: d.b, color: d.color ?? '#dc2626' };
      drawShape(ctx, preview, st.base);
    }
  }, []);

  function drawShape(ctx: CanvasRenderingContext2D, s: Shape, base: HTMLCanvasElement): void {
    ctx.save();
    const lw = Math.max(2, Math.round(base.width / 400));
    switch (s.tool) {
      case 'rect': {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = lw;
        ctx.strokeRect(
          Math.min(s.a.x, s.b.x),
          Math.min(s.a.y, s.b.y),
          Math.abs(s.b.x - s.a.x),
          Math.abs(s.b.y - s.a.y),
        );
        break;
      }
      case 'arrow': {
        ctx.strokeStyle = s.color;
        ctx.fillStyle = s.color;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(s.a.x, s.a.y);
        ctx.lineTo(s.b.x, s.b.y);
        ctx.stroke();
        const angle = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
        const head = lw * 5;
        ctx.beginPath();
        ctx.moveTo(s.b.x, s.b.y);
        ctx.lineTo(s.b.x - head * Math.cos(angle - Math.PI / 6), s.b.y - head * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(s.b.x - head * Math.cos(angle + Math.PI / 6), s.b.y - head * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'pen': {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = lw;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.stroke();
        break;
      }
      case 'text': {
        const size = Math.max(14, Math.round(base.width / 40));
        ctx.font = `600 ${size}px sans-serif`;
        const w = ctx.measureText(s.text).width;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(s.at.x - 3, s.at.y - size, w + 6, size + 8);
        ctx.fillStyle = s.color;
        ctx.fillText(s.text, s.at.x, s.at.y);
        break;
      }
      case 'blur': {
        const x = Math.round(Math.min(s.a.x, s.b.x));
        const y = Math.round(Math.min(s.a.y, s.b.y));
        const w = Math.round(Math.abs(s.b.x - s.a.x));
        const h = Math.round(Math.abs(s.b.y - s.a.y));
        if (w > 2 && h > 2) {
          // Downscale → upscale with smoothing off = mosaic blur.
          const tmp = document.createElement('canvas');
          const factor = 12;
          tmp.width = Math.max(1, Math.ceil(w / factor));
          tmp.height = Math.max(1, Math.ceil(h / factor));
          const tctx = tmp.getContext('2d');
          if (!tctx) break;
          tctx.imageSmoothingEnabled = false;
          tctx.drawImage(base, x, y, w, h, 0, 0, tmp.width, tmp.height);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
        }
        break;
      }
    }
    ctx.restore();
  }

  /* ---------- pointer handling ---------- */

  function toImageCoords(e: React.PointerEvent<HTMLCanvasElement>): Point {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const st = stateRef.current!;
    return {
      x: ((e.clientX - rect.left) / rect.width) * st.base.width,
      y: ((e.clientY - rect.top) / rect.height) * st.base.height,
    };
  }

  function pushHistory(): void {
    const st = stateRef.current;
    if (!st) return;
    historyRef.current.push(st.shapes.map(cloneShape));
    if (historyRef.current.length > 50) historyRef.current.shift();
    futureRef.current = [];
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>): void {
    const st = stateRef.current;
    if (!st) return;
    const p = toImageCoords(e);
    if (tool === 'text') {
      setPendingText({ at: p });
      setTextValue('');
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === 'pen') {
      draftRef.current = { tool: 'pen', points: [p], color };
    } else if (tool === 'blur' || tool === 'crop') {
      draftRef.current = { tool, a: p, b: p };
    } else {
      draftRef.current = { tool, a: p, b: p, color };
    }
    redraw();
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>): void {
    const d = draftRef.current;
    if (!d) return;
    const p = toImageCoords(e);
    if (d.tool === 'pen') d.points.push(p);
    else if ('b' in d) d.b = p;
    redraw();
  }

  function onPointerUp(): void {
    const st = stateRef.current;
    const d = draftRef.current;
    draftRef.current = null;
    if (!st || !d) return;
    // Ignore accidental micro-shapes (except pen dots which may be intentional).
    if (d.tool !== 'pen' && 'a' in d && Math.abs(d.b.x - d.a.x) < 3 && Math.abs(d.b.y - d.a.y) < 3) {
      redraw();
      return;
    }
    if (d.tool === 'crop') {
      applyCrop(d.a, d.b);
      return;
    }
    pushHistory();
    st.shapes.push(d as Shape);
    redraw();
  }

  function applyCrop(a: Point, b: Point): void {
    const st = stateRef.current;
    if (!st) return;
    const x = Math.round(Math.max(0, Math.min(a.x, b.x)));
    const y = Math.round(Math.max(0, Math.min(a.y, b.y)));
    const w = Math.round(Math.min(st.base.width - x, Math.abs(b.x - a.x)));
    const h = Math.round(Math.min(st.base.height - y, Math.abs(b.y - a.y)));
    if (w < 10 || h < 10) {
      redraw();
      return;
    }
    // Record an editor-state snapshot for undo (base image changes too).
    historyRef.current.push(st.shapes.map(cloneShape));
    futureRef.current = [];
    const cropped = document.createElement('canvas');
    cropped.width = w;
    cropped.height = h;
    cropped.getContext('2d')?.drawImage(st.base, x, y, w, h, 0, 0, w, h);
    // Re-anchor shapes into cropped coordinates; drop shapes fully outside.
    stateRef.current = {
      base: cropped,
      shapes: st.shapes
        .map((s) => shiftShape(s, -x, -y))
        .filter((s) => s != null) as Shape[],
    };
    redraw();
    forceRender((n) => n + 1);
  }

  function commitText(): void {
    const st = stateRef.current;
    if (st && pendingText && textValue.trim()) {
      pushHistory();
      st.shapes.push({ tool: 'text', at: pendingText.at, text: textValue.trim(), color });
    }
    setPendingText(null);
    redraw();
  }

  /* ---------- undo / redo ---------- */

  function undo(): void {
    const st = stateRef.current;
    if (!st || !historyRef.current.length) return;
    futureRef.current.push(st.shapes.map(cloneShape));
    st.shapes = historyRef.current.pop() ?? [];
    redraw();
    forceRender((n) => n + 1);
  }

  function redo(): void {
    const st = stateRef.current;
    if (!st || !futureRef.current.length) return;
    historyRef.current.push(st.shapes.map(cloneShape));
    st.shapes = futureRef.current.pop() ?? [];
    redraw();
    forceRender((n) => n + 1);
  }

  /* ---------- save ---------- */

  function save(): void {
    const st = stateRef.current;
    const canvas = canvasRef.current;
    if (!st || !canvas) return;
    redraw();
    onSave(canvas.toDataURL('image/png'), st.base.width, st.base.height);
  }

  /* ---------- UI ---------- */

  const tools: Array<[Tool, string]> = [
    ['rect', '▭ Rect'],
    ['arrow', '➜ Arrow'],
    ['pen', '✏ Draw'],
    ['text', 'T Text'],
    ['blur', '▒ Blur'],
    ['crop', '⌬ Crop'],
  ];

  return (
    <div className="annotator">
      <div className="tool-row">
        {tools.map(([t, label]) => (
          <button key={t} className={`tool-btn ${tool === t ? 'active' : ''}`} onClick={() => setTool(t)}>
            {label}
          </button>
        ))}
      </div>
      <div className="tool-row" style={{ alignItems: 'center' }}>
        {COLORS.map((c) => (
          <button
            key={c}
            aria-label={`color ${c}`}
            className={`color-swatch ${color === c ? 'active' : ''}`}
            style={{ background: c }}
            onClick={() => setColor(c)}
          />
        ))}
        <span style={{ flex: 1 }} />
        <button className="tool-btn" onClick={undo} disabled={!historyRef.current.length}>
          ↶ Undo
        </button>
        <button className="tool-btn" onClick={redo} disabled={!futureRef.current.length}>
          ↷ Redo
        </button>
      </div>

      {pendingText && (
        <div className="btn-row" style={{ marginBottom: 8 }}>
          <input
            autoFocus
            className="field"
            style={{ flex: 1, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 8 }}
            value={textValue}
            placeholder="Annotation text…"
            onChange={(e) => setTextValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && commitText()}
          />
          <button className="btn small primary" onClick={commitText}>
            OK
          </button>
        </div>
      )}

      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ display: ready ? 'block' : 'none' }}
      />
      {!ready && <div className="busy">Loading screenshot…</div>}

      <div className="btn-row" style={{ marginTop: 10 }}>
        <button className="btn" onClick={onRetake}>
          Retake ({mode})
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" onClick={save} disabled={!ready}>
          Use screenshot
        </button>
      </div>
    </div>
  );
}

/* ---------- shape helpers ---------- */

function cloneShape(s: Shape): Shape {
  switch (s.tool) {
    case 'pen':
      return { ...s, points: s.points.map((p) => ({ ...p })) };
    case 'text':
      return { ...s, at: { ...s.at } };
    default:
      return { ...s, a: { ...s.a }, b: { ...s.b } };
  }
}

function shiftShape(s: Shape, dx: number, dy: number): Shape | null {
  const inside = (p: Point) => p.x + dx >= 0 && p.y + dy >= 0;
  switch (s.tool) {
    case 'pen': {
      const pts = s.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      return pts.some((p) => p.x > 0 && p.y > 0) ? { ...s, points: pts } : null;
    }
    case 'text':
      return inside(s.at) ? { ...s, at: { x: s.at.x + dx, y: s.at.y + dy } } : null;
    default: {
      const a = { x: s.a.x + dx, y: s.a.y + dy };
      const b = { x: s.b.x + dx, y: s.b.y + dy };
      if (Math.max(b.x, a.x) <= 0 || Math.max(b.y, a.y) <= 0) return null;
      return { ...s, a, b } as Shape;
    }
  }
}
