/**
 * Client-side exports: Markdown (clipboard), JSON and PDF downloads.
 * Nothing here talks to the backend – these work fully offline.
 */

import type { BugReport } from '../types';
import { REPORT_TYPE_LABELS } from '../types';

function consoleErrors(r: BugReport) {
  return r.consoleEntries.filter((c) => c.type === 'error' || c.type === 'exception' || c.type === 'rejection');
}

function apiErrors(r: BugReport) {
  return r.networkEntries.filter((n) => n.failed || n.status >= 400);
}

export function toMarkdown(r: BugReport): string {
  const f = r.form;
  const lines: string[] = [
    `## ${r.id}: ${f.title || '(untitled)'}`,
    '',
    `**Type:** ${REPORT_TYPE_LABELS[f.reportType ?? 'bug']} · **Severity:** ${f.severity} · **Priority:** ${f.priority}`,
    `**URL:** ${r.page.url}`,
    `**Environment:** ${r.environment.browserName} ${r.environment.browserVersion} · ${r.environment.operatingSystem} · viewport ${r.environment.viewportWidth}×${r.environment.viewportHeight}`,
    '',
    '### Description',
    f.description || '_none_',
  ];
  if (f.stepsToReproduce.length) {
    lines.push('', '### Steps to reproduce', ...f.stepsToReproduce.filter(Boolean).map((s, i) => `${i + 1}. ${s}`));
  }
  if (f.expectedResult) lines.push('', '### Expected result', f.expectedResult);
  if (f.actualResult) lines.push('', '### Actual result', f.actualResult);
  if (f.additionalNotes) lines.push('', '### Notes', f.additionalNotes);
  if (r.ai?.possibleCause) lines.push('', '### Possible cause (AI hypothesis)', r.ai.possibleCause);

  const ce = consoleErrors(r);
  const ae = apiErrors(r);
  if (ce.length || ae.length) {
    lines.push('', '### Technical evidence', '```');
    for (const c of ce.slice(-10)) lines.push(`[console ${c.type}] ${c.message}${c.source ? ` (${c.source}${c.line ? `:${c.line}` : ''})` : ''}`);
    for (const n of ae.slice(-10)) lines.push(`[network] ${n.method} ${n.url} → ${n.failed ? n.errorText : n.status}`);
    lines.push('```');
  }
  return lines.join('\n');
}

export async function copyMarkdown(r: BugReport): Promise<void> {
  await navigator.clipboard.writeText(toMarkdown(r));
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJson(r: BugReport): void {
  download(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }), `${r.id}.json`);
}

export async function downloadPdf(r: BugReport): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  const width = pageW - margin * 2;
  let y = margin;

  const ensure = (h: number) => {
    if (y + h > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };
  const text = (s: string, size = 10, bold = false) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    for (const line of doc.splitTextToSize(s, width) as string[]) {
      ensure(size * 1.4);
      doc.text(line, margin, y);
      y += size * 1.4;
    }
  };
  const section = (title: string, body: string) => {
    if (!body) return;
    y += 8;
    text(title, 12, true);
    text(body);
  };

  const f = r.form;
  text(`${r.id}: ${f.title || '(untitled)'}`, 16, true);
  text(`${REPORT_TYPE_LABELS[f.reportType ?? 'bug']} · Severity ${f.severity} · Priority ${f.priority}`, 10);
  text(`URL: ${r.page.url}`, 9);
  text(
    `Environment: ${r.environment.browserName} ${r.environment.browserVersion} · ${r.environment.operatingSystem} · viewport ${r.environment.viewportWidth}×${r.environment.viewportHeight}`,
    9,
  );

  if (r.screenshot) {
    const { width: iw, height: ih } = r.screenshot;
    if (iw > 0 && ih > 0) {
      const scale = Math.min(width / iw, (pageH - margin * 2) / ih);
      const w = iw * scale;
      const h = ih * scale;
      y += 10;
      ensure(h);
      doc.addImage(r.screenshot.dataUrl, 'PNG', margin, y, w, h);
      y += h;
    }
  }

  section('Description', f.description);
  section('Steps to reproduce', f.stepsToReproduce.filter(Boolean).map((s, i) => `${i + 1}. ${s}`).join('\n'));
  section('Expected result', f.expectedResult);
  section('Actual result', f.actualResult);
  section('Notes', f.additionalNotes);
  section('Possible cause (AI hypothesis)', r.ai?.possibleCause ?? '');
  section(
    'Technical evidence',
    [
      ...consoleErrors(r).slice(-10).map((c) => `[console ${c.type}] ${c.message}`),
      ...apiErrors(r).slice(-10).map((n) => `[network] ${n.method} ${n.url} → ${n.failed ? n.errorText : n.status}`),
    ].join('\n'),
  );

  download(doc.output('blob'), `${r.id}.pdf`);
}
