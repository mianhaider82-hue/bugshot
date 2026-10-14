/** Validation + Sheets row mapping for submitted reports (extension: toSheetPayload). */

import { z } from 'zod';

const ConsoleError = z.object({ type: z.string(), message: z.string(), source: z.string().optional() }).passthrough();
const ApiError = z
  .object({ method: z.string(), url: z.string(), status: z.number(), failed: z.boolean(), errorText: z.string().optional() })
  .passthrough();

export const SubmitRequestSchema = z.object({
  spreadsheetId: z.string().min(1, 'Choose a spreadsheet in Settings first'),
  worksheet: z.string().min(1).default('Bug Reports'),
  screenshotUrl: z.string().url().optional(),
  report: z.object({
    id: z.string(),
    createdAt: z.string(),
    form: z.object({
      reportType: z.enum(['bug', 'design', 'improvement']).default('bug'),
      title: z.string(),
      description: z.string(),
      stepsToReproduce: z.array(z.string()),
      expectedResult: z.string(),
      actualResult: z.string(),
      severity: z.string(),
      priority: z.string(),
      additionalNotes: z.string().default(''),
    }),
    ai: z.object({ possibleCause: z.string().optional() }).passthrough().nullable(),
    page: z.object({ url: z.string() }).passthrough(),
    environment: z
      .object({
        browserName: z.string(),
        browserVersion: z.string(),
        operatingSystem: z.string(),
        viewportWidth: z.number(),
        viewportHeight: z.number(),
      })
      .passthrough(),
    consoleErrors: z.array(ConsoleError),
    apiErrors: z.array(ApiError),
  }),
});
export type SubmitRequest = z.infer<typeof SubmitRequestSchema>;

const TYPE_LABELS = { bug: 'Bug', design: 'Design change', improvement: 'Improvement' } as const;

/** Sheets cells cap at 50k chars; keep evidence cells readable. */
const cell = (s: string, max = 2000) => (s.length > max ? `${s.slice(0, max)}…` : s);

export function reportToRow(r: SubmitRequest['report'], screenshotUrl?: string): string[] {
  const f = r.form;
  return [
    r.id,
    r.createdAt,
    TYPE_LABELS[f.reportType],
    f.title,
    f.severity,
    f.priority,
    cell(f.description, 5000),
    f.stepsToReproduce.filter(Boolean).map((s, i) => `${i + 1}. ${s}`).join('\n'),
    cell(f.expectedResult),
    cell(f.actualResult),
    cell(f.additionalNotes),
    cell(r.ai?.possibleCause ?? ''),
    r.page.url,
    `${r.environment.browserName} ${r.environment.browserVersion}`,
    r.environment.operatingSystem,
    `${r.environment.viewportWidth}×${r.environment.viewportHeight}`,
    cell(r.consoleErrors.slice(-10).map((c) => `[${c.type}] ${c.message}`).join('\n')),
    cell(r.apiErrors.slice(-10).map((n) => `${n.method} ${n.url} → ${n.failed ? n.errorText : n.status}`).join('\n')),
    screenshotUrl ?? '',
  ];
}
