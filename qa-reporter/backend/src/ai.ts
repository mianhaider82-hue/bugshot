/**
 * OpenAI analysis: screenshot + tester note + technical evidence → a
 * structured bug report (title, description, steps, expected/actual, …).
 */

import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { config } from './config.js';

const client = new OpenAI();

export const AnalysisSchema = z.object({
  title: z.string().describe('Short, specific report title (max ~80 chars)'),
  summary: z.string().describe('One sentence summary'),
  description: z.string().describe('Clear description of the problem or requested change'),
  stepsToReproduce: z.array(z.string()).describe('Numbered steps, one action per step, no numbering prefix'),
  expectedResult: z.string(),
  actualResult: z.string(),
  severity: z.enum(['Critical', 'High', 'Medium', 'Low']),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  technicalEvidence: z.array(z.string()).describe('The specific console errors / failed requests that support the report'),
  possibleCause: z.string().describe('Hypothesis about the root cause, or empty string if there is no evidence'),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

/** Shape sent by the extension (services/api.ts → toAiPayload). */
export const AnalyzeRequestSchema = z.object({
  reportType: z.enum(['bug', 'design', 'improvement']).default('bug'),
  testerNote: z.string().default(''),
  page: z.object({ url: z.string(), title: z.string() }).passthrough(),
  environment: z.record(z.string(), z.unknown()),
  form: z.record(z.string(), z.unknown()),
  consoleEntries: z.array(z.record(z.string(), z.unknown())).default([]),
  networkEntries: z.array(z.record(z.string(), z.unknown())).default([]),
  actions: z.array(z.record(z.string(), z.unknown())).default([]),
  screenshot: z.object({ dataUrl: z.string(), mode: z.string() }).nullable().default(null),
});
export type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>;

const SYSTEM_PROMPT = `You are a senior QA engineer turning a tester's quick capture into a report a developer or designer can act on without asking follow-up questions.

You receive:
- A screenshot of the page. The tester may have annotated it: rectangles, arrows, pen strokes and text labels mark the area they care about. Mosaic/pixelated areas were blurred on purpose for privacy - ignore them.
- The tester's own note. It is the primary source of intent; the evidence supports it.
- Technical evidence captured from the browser tab: console errors, network requests, recent user actions, page URL and environment. Secrets have been redacted.

Report types:
- "bug": something is broken. Use the console/network evidence to pinpoint what failed. Steps should reproduce the failure from the page load. Actual result = what happens now; expected result = correct behaviour.
- "design": a visual or UX change. Steps describe how to reach the screen and element. Actual result describes the current design; expected result describes the requested design. Severity is usually Low or Medium. Leave possibleCause empty unless the evidence shows a technical cause (e.g. a missing asset).
- "improvement": a feature or behaviour enhancement, written like "design".

Rules:
- Ground every claim in the screenshot, note or evidence. Do not invent error messages, endpoints or UI text you cannot see.
- If the tester already filled a field (given under "Fields the tester already filled"), keep its meaning and only polish wording.
- Only cite evidence that is relevant; unrelated noise (analytics, ad blockers, favicon 404s) should not drive the report.
- Severity: Critical = data loss, security or blocks core flow for everyone; High = core feature broken; Medium = feature partially broken or notable UX problem; Low = cosmetic. Priority follows severity unless the note says otherwise.
- possibleCause is a hypothesis; state it plainly, or use an empty string when there is nothing to go on.
- Write in the same language as the tester's note.`;

function compactJson(v: unknown, max = 12_000): string {
  const s = JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

function evidenceText(req: AnalyzeRequest): string {
  const relevantNetwork = req.networkEntries.filter(
    (n) => n.failed === true || (typeof n.status === 'number' && n.status >= 400) || n.resourceType === 'XHR/Fetch' || n.resourceType === 'Fetch' || n.resourceType === 'XHR',
  );
  const filled = Object.fromEntries(
    Object.entries(req.form).filter(
      ([k, v]) => !['reportType', 'additionalNotes', 'severity', 'priority'].includes(k) && (Array.isArray(v) ? v.some(Boolean) : Boolean(v)),
    ),
  );
  return [
    `Report type: ${req.reportType}`,
    `Tester's note:\n${req.testerNote || '(none - infer from the screenshot annotations and evidence)'}`,
    Object.keys(filled).length ? `Fields the tester already filled: ${compactJson(filled)}` : '',
    `Page: ${req.page.title} - ${req.page.url}`,
    `Environment: ${compactJson(req.environment, 2000)}`,
    `Console entries (oldest first, ${req.consoleEntries.length}): ${compactJson(req.consoleEntries)}`,
    `Network requests - API calls and failures (oldest first, ${relevantNetwork.length}): ${compactJson(relevantNetwork)}`,
    `Recent user actions (oldest first): ${compactJson(req.actions, 4000)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

const SUPPORTED_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,/;

export class AiRefusalError extends Error {}

export async function analyzeReport(req: AnalyzeRequest): Promise<Analysis> {
  const content: OpenAI.Chat.ChatCompletionContentPart[] = [];
  if (req.screenshot && SUPPORTED_IMAGE.test(req.screenshot.dataUrl)) {
    content.push(
      { type: 'image_url', image_url: { url: req.screenshot.dataUrl, detail: 'high' } },
      { type: 'text', text: `Screenshot mode: ${req.screenshot.mode}` },
    );
  }
  content.push({ type: 'text', text: evidenceText(req) });

  const completion = await client.chat.completions.parse({
    model: config.openaiModel,
    max_completion_tokens: 4096,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ],
    response_format: zodResponseFormat(AnalysisSchema, 'qa_report'),
  });

  const choice = completion.choices[0];
  if (choice?.message.refusal) throw new AiRefusalError(choice.message.refusal);
  if (!choice?.message.parsed) {
    throw new Error(`AI returned no structured output (finish_reason: ${choice?.finish_reason})`);
  }
  return choice.message.parsed;
}
