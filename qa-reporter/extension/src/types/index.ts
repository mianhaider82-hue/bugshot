/**
 * QA Reporter – shared type definitions.
 * These types are used across background, content and popup contexts.
 */

/* ------------------------------------------------------------------ */
/* Screenshot                                                         */
/* ------------------------------------------------------------------ */

export type ScreenshotMode = 'viewport' | 'fullpage';

export interface ScreenshotData {
  /** PNG data URL of the captured image */
  dataUrl: string;
  width: number;
  height: number;
  mode: ScreenshotMode;
  capturedAt: string; // ISO timestamp
}

/* ------------------------------------------------------------------ */
/* Page / environment information                                     */
/* ------------------------------------------------------------------ */

export interface PageInfo {
  url: string;
  title: string;
  referrer: string;
  timestamp: string; // ISO
  tabId: number;
  windowId: number;
}

export interface EnvironmentInfo {
  browserName: string;
  browserVersion: string;
  operatingSystem: string;
  platform: string;
  screenResolution: string; // e.g. "1920x1080"
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  userAgent: string;
  language: string;
}

/* ------------------------------------------------------------------ */
/* Console log collection (Phase 2)                                   */
/* ------------------------------------------------------------------ */

export type ConsoleEntryType = 'error' | 'warn' | 'info' | 'exception' | 'rejection';

export interface ConsoleEntry {
  type: ConsoleEntryType;
  message: string;
  source: string; // file name / URL where the log originated
  line?: number;
  column?: number;
  timestamp: string; // ISO
  stack?: string;
}

/* ------------------------------------------------------------------ */
/* Network log collection (Phase 2)                                   */
/* ------------------------------------------------------------------ */

export interface NetworkEntry {
  url: string;
  method: string;
  status: number;
  statusText?: string;
  requestTimestamp: string;
  responseTimestamp?: string;
  durationMs?: number;
  resourceType?: string;
  failed: boolean;
  errorText?: string;
  /** Redacted request payload (if safe & available) */
  requestBody?: string;
  /** Redacted response body snippet (if safe & available) */
  responseBody?: string;
}

/* ------------------------------------------------------------------ */
/* User action tracking (Phase 2)                                     */
/* ------------------------------------------------------------------ */

export type ActionType = 'click' | 'input' | 'select' | 'navigation' | 'form-submit';

export interface TrackedAction {
  type: ActionType;
  label: string; // human readable, e.g. Clicked "Login"
  target?: string; // css-ish selector description
  value?: string; // always redacted for sensitive fields
  timestamp: string;
}

/* ------------------------------------------------------------------ */
/* Bug report                                                         */
/* ------------------------------------------------------------------ */

export type Severity = 'Critical' | 'High' | 'Medium' | 'Low';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

export type ReportStatus = 'draft' | 'ready' | 'submitted' | 'failed';

export interface BugReportForm {
  title: string;
  description: string;
  stepsToReproduce: string[];
  expectedResult: string;
  actualResult: string;
  severity: Severity;
  priority: Priority;
  additionalNotes: string;
}

export interface AiAnalysis {
  title: string;
  summary: string;
  description: string;
  stepsToReproduce: string[];
  expectedResult: string;
  actualResult: string;
  severity: Severity;
  priority: Priority;
  technicalEvidence: string[];
  possibleCause: string;
}

export interface BugReport {
  id: string; // BUG-0001 style id assigned on save
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  status: ReportStatus;

  form: BugReportForm;
  page: PageInfo;
  environment: EnvironmentInfo;

  screenshot?: ScreenshotData;
  consoleEntries: ConsoleEntry[];
  networkEntries: NetworkEntry[];
  actions: TrackedAction[];

  ai?: AiAnalysis;
  sheetRowId?: string; // set once submitted to Google Sheets
  errors: string[]; // non-fatal integration errors recorded during the session
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

export interface PrivacySettings {
  collectConsole: boolean;
  collectNetwork: boolean;
  trackActions: boolean;
  captureScreenshot: boolean;
  redactEnabled: boolean;
}

export interface AppSettings {
  backendUrl: string;
  aiEnabled: boolean;
  sheetsSpreadsheetId: string;
  sheetsWorksheet: string;
  privacy: PrivacySettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  backendUrl: 'http://localhost:4000',
  aiEnabled: true,
  sheetsSpreadsheetId: '',
  sheetsWorksheet: 'Bug Reports',
  privacy: {
    collectConsole: true,
    collectNetwork: true,
    trackActions: true,
    captureScreenshot: true,
    redactEnabled: true,
  },
};

/* ------------------------------------------------------------------ */
/* Messaging (popup <-> background <-> content)                       */
/* ------------------------------------------------------------------ */

export type RuntimeMessage =
  | { kind: 'START_SESSION'; sessionId: string }
  | { kind: 'END_SESSION'; sessionId: string }
  | { kind: 'CAPTURE_PAGE_INFO'; sessionId: string }
  | { kind: 'PAGE_INFO_RESULT'; pageInfo: PageInfo; environment: EnvironmentInfo }
  | { kind: 'CONSOLE_ENTRIES'; entries: ConsoleEntry[] }
  | { kind: 'ACTION_TRACKING'; actions: TrackedAction[] }
  | { kind: 'GET_CONSOLE_ENTRIES' }
  | { kind: 'GET_ACTION_TRACKING' }
  | { kind: 'CONSOLE_ENTRIES_RESULT'; entries: ConsoleEntry[] }
  | { kind: 'ACTION_TRACKING_RESULT'; actions: TrackedAction[] }
  | { kind: 'PING' };

export interface SessionState {
  active: boolean;
  sessionId: string | null;
  startedAt: string | null;
  tabId: number | null;
}
