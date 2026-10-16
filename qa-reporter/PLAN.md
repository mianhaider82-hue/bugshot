# QA Reporter — Build Plan

## Context

`qa-reporter/extension/` already contains most of the Chrome extension: an MV3 + React + Vite popup, a background worker, a content script, an annotation editor, redaction and local drafts. It was built against a backend that doesn't exist yet, and it has blocking bugs. This plan does three things:
1. Fixes the extension and closes its gaps against the spec.
2. Builds the missing `qa-reporter/backend/` (Node + TypeScript, Express, OpenAI, Google OAuth/Sheets, **Firebase Firestore** for persistence, **Cloudinary** for screenshots).
3. Adds the deliverables: tests, lint, docs and the testing checklist.

User decisions: screenshots go to Cloudinary, AI uses OpenAI `gpt-4o`, and persistence uses Firebase (Firestore via `firebase-admin`).

---

## Part A — Extension: fixes and gaps (Phases 1, 2 and 5)

### A1. Blocking bugs
- **Duplicate `onMessage` listeners**, [background/index.ts:356](qa-reporter/extension/src/background/index.ts#L356) and `:435`. The first listener's `default` branch calls `sendResponse({ok:false,'unknown message'})` synchronously, so every `POPUP_*` message gets that reply. Screenshots fail, and evidence comes back empty, so `sanitizeReport` crashes on `.map`.
  - Fix: merge both into one router with a handler map, `Record<kind, handler>`. Return `false` without replying for kinds it doesn't own.
  - Add `POPUP_*` variants to the `RuntimeMessage` union in [types/index.ts](qa-reporter/extension/src/types/index.ts).
- **`finishEvidence` has no `catch`** ([useReportSession.ts](qa-reporter/extension/src/hooks/useReportSession.ts)). Add one that records the error and still moves on to `review`, which spec #18 requires.
- **The worker restores state but not the debugger attachment.** On restore, if `session.active`, re-attach network capture to `session.tabId`.

### A2. Privacy toggles are not enforced (spec #14, #17)
- `collectConsole`, `collectNetwork` and `trackActions` are saved but ignored. Send the privacy flags with `START_SESSION`:
  - The content script gates console hooks and action tracking on them.
  - The background skips `attachNetwork` when `collectNetwork` is off.
- Load the user-configurable redaction field list from settings and pass it to `configureRedaction` ([utils/redaction.ts](qa-reporter/extension/src/utils/redaction.ts)) in the popup and the content script. Add an "Extra sensitive field names" input to Settings.
- Add header redaction for network entries: capture request/response headers through CDP and run them through `redactHeaders`. It exists but is never used.
- Add a **"What will be collected"** summary card on the capture screen. It lists the active collectors, and Cancel is always visible.

### A3. Screenshot flow (spec #4)
- Add a third **"Select area"** option to [CaptureScreen.tsx](qa-reporter/extension/src/components/CaptureScreen.tsx). It captures the viewport, then opens the editor with the crop tool preselected through a new `initialTool` prop on [AnnotationEditor.tsx](qa-reporter/extension/src/components/AnnotationEditor.tsx).
- "Retake" already exists through `onRetake`; keep it.
- Make sure `useReportSession.startReport` goes to `capturing`, not straight to `annotating`. Today it ends at `setPhase('annotating')` and relies on the App fallback, which should be cleaned up.

### A4. Session evidence across page reloads
- The content script resets `sessionActive=false` on every page load. On load it should `PING` the background and resume if the session is active and `tabId` matches. Without this, logs after a navigation are lost.
- Use `chrome.scripting.executeScript` to inject the content script into tabs that were open before install. This needs the `scripting` permission.

### A5. Backend client hardening
- `BackendClient` ([services/api.ts](qa-reporter/extension/src/services/api.ts)) must send `Authorization: Bearer <token>` from `getAuthToken()` ([services/session.ts](qa-reporter/extension/src/services/session.ts)). Fold `authedFetch` from `google.ts` into a single shared `http.ts`.
- `submitToSheets` must include `spreadsheetId` and `worksheet` from settings.
- Bug IDs: call `POST /api/bugs/next-id` at report start. Offline, fall back to `LOCAL-xxxx` from the existing `nextBugId()`, and the backend assigns the real `BUG-####` at submit.
- Settings: add a **Sign out** button (`POST /api/auth/google/logout` + `clearAuthToken`), show the connected Google email (`GET /api/auth/me`), and keep the existing health indicator.
- Add a **Retry submit** action on reports with status `failed` or `draft` in the Recent list.

### A6. Tooling (spec #22)
- Rename `vite.config.mts` → `vite.config.ts` as the spec says (or keep `.mts` and fix the `tsconfig` include, which currently points at `vite.config.ts`).
- Add `.eslintrc.cjs` and `.prettierrc` (the scripts reference them, but they're missing).
- Add a `vitest` config with a `chrome` API mock.
- Unit tests:
  - `utils/redaction` (JSON, form, Bearer, Luhn, URL creds, headers)
  - `storage` (draft upsert, quota fallback)
  - `applyAi` merge (move to `utils/report.ts` so it can be tested)
  - `sanitizeReport`
  - the background message router

---

## Part B — Backend (`qa-reporter/backend/`, Phases 3 and 4)

Stack: Node 20, TypeScript strict, Express, `zod` for validation, `express-rate-limit`, `helmet`, `cors`, `pino` with a redaction config, `openai`, `googleapis`, `firebase-admin`, `vitest` + `supertest`.

```
backend/
  src/
    index.ts                # bootstrap, graceful shutdown
    app.ts                  # express app (exported for tests)
    config.ts               # zod-validated env
    routes/                 # health, auth, ai, sheets, screenshots, bugs
    controllers/
    middleware/             # auth (bearer), rateLimit, validate(zod), errorHandler, requestLogger
    services/               # reportService (row mapping), bugIdService
    ai/                     # openaiClient, prompt.ts, schema.ts (zod for AI JSON)
    google/                 # oauth.ts, sheets.ts
    storage/                # firestore.ts, tokenStore.ts, (screenshots → Cloudinary)
    utils/                  # crypto (AES-256-GCM), redact, errors
  test/
  .env.example
```

### Endpoints (all JSON; everything except health and the OAuth callback requires a Bearer token)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness, plus whether OpenAI and Google are configured |
| POST | `/api/auth/session` | Issue a random extension token (store its SHA-256 in Firestore `sessions`) |
| GET | `/api/auth/me` | Connected Google email or null |
| GET | `/api/auth/google/login?token=…` | Start OAuth. `state` = signed nonce bound to the session. Scopes: `spreadsheets`, `drive.metadata.readonly`, `userinfo.email` |
| GET | `/api/auth/google/callback` | Exchange the code, encrypt the refresh token (AES-GCM, key from env), store it against the session, then show a "You can close this tab" page |
| POST | `/api/auth/google/logout` | Revoke the token and delete it |
| POST | `/api/bugs/next-id` | Firestore transaction on `counters/bugs` → `BUG-0001`… |
| POST | `/api/analyze` | Validate the payload, re-run server-side redaction, call OpenAI, validate the output, return `{analysis}` |
| POST | `/api/screenshot` | Validate the PNG/JPEG data URL and upload it to Cloudinary. Return the `secure_url` |
| GET | `/api/sheets/list` | Drive files list, `mimeType=spreadsheet` |
| GET | `/api/sheets/worksheets` | Tab titles |
| POST | `/api/sheets/submit` | Assign or confirm the bug ID, ensure the header row exists, append the row with the spec #13 columns. Return `{rowId, bugId}` |

### AI (spec #10, #11)
- Use OpenAI Chat Completions with a vision-capable model (`OPENAI_MODEL` env, default `gpt-4o`) and `response_format: json_schema` (strict) that matches `AiAnalysis` plus `observedEvidence[]` / `visualFindings[]`.
- Pass the screenshot as an `image_url` data URL.
- System prompt rules:
  - Use only the supplied evidence.
  - Write `"Unknown"` when something can't be determined.
  - Every `technicalEvidence` item must quote a supplied log line.
  - Keep `possibleCause` explicitly labeled as a hypothesis.
  - List visible UI problems separately.
- After the call, validate with zod. Drop any `technicalEvidence` item that can't be matched to an input URL or console message. This guard enforces "no invented evidence".
- Set timeouts and one retry on 429/5xx. Errors map to clean 502 messages.

### Security (spec #16)
- Validate env at boot. Secrets come only from env; the Firebase service account comes from `GOOGLE_APPLICATION_CREDENTIALS` or `FIREBASE_SERVICE_ACCOUNT_JSON`.
- `cors` allowlist: `chrome-extension://<EXTENSION_ID>` (env) plus localhost in dev.
- Rate limits: global 120/min per token, `/api/analyze` 10/min.
- Body limit 10 MB on `/api/analyze` and `/api/screenshot`, 200 KB elsewhere.
- `pino` redact paths: `req.headers.authorization`, `cookie`, `*.token`, `*.password`, `body`. Never log payloads.
- Central error handler: no stack traces in production.

### Firestore collections
`sessions/{tokenHash}` → `{createdAt, lastSeen, googleEmail?, refreshTokenEnc?}`; `counters/bugs` → `{next}`; `reports/{bugId}` → metadata only (sheet row, screenshot URL, createdAt), for idempotent resubmits.

---

## Part C — Docs and deliverables (spec #23)
- `qa-reporter/README.md`, covering:
  - architecture diagram
  - setup for OpenAI, Google Cloud (OAuth client, consent screen, Sheets and Drive APIs, redirect URI), Firebase (project + service account) and Cloudinary credentials
  - `.env.example` walkthrough
  - build steps for both packages
  - Chrome developer-mode install
  - production deploy (Node host, HTTPS, set `PUBLIC_BASE_URL` / `EXTENSION_ID`, pin the extension key in the manifest so the ID is stable)
  - troubleshooting: debugger banner, DevTools conflict, reloading tabs
- `docs/TESTING_CHECKLIST.md`: a manual end-to-end checklist per phase and per failure mode (backend down, AI fails, Sheets fails, quota, offline, draft recovery).
- Root `package.json` with npm workspaces (`extension`, `backend`) and `dev`, `build`, `test`, `lint` scripts. Remove the stray empty `qa-reporter/package-lock.json`.

---

## Execution order
1. A1 + A6 (fix bugs and add the test harness) → the extension works fully offline (Phases 1 and 2 done).
2. B skeleton: config, app, health, auth session, Firestore, error/log/rate-limit middleware, tests.
3. B AI route, then A5 auth header → Phase 3.
4. B Google OAuth, Sheets, screenshots, bug IDs, then Settings sign-out/me → Phase 4.
5. A2–A4 privacy, area select, reload resume → Phase 5 polish.
6. Part C docs and checklist.

## Verification
- `npm run lint && npm test` in both packages. Unit tests cover redaction, storage, the message router, AI output validation, row mapping, auth middleware, rate limiting and the screenshot filename guard (supertest with Firestore and OpenAI mocked).
- `npm run build` in extension → load `dist/` unpacked:
  1. On a test page that throws `console.error`, an uncaught error, a failing `fetch` to a 500 endpoint, and a password input: Report Bug → each capture mode works → annotate → evidence shows the console, network and actions with the password `[REDACTED]`.
  2. Backend stopped: AI and submit fail with messages, and the report is saved locally as `failed`. Retry after starting the backend succeeds.
  3. Backend running with real keys: AI fills the form, Connect Google → pick spreadsheet and tab → Submit → row appears with `BUG-000N` and a working screenshot URL.
  4. Close the popup mid-report or restart Chrome → the Recover banner restores the draft.
  5. Turn each privacy toggle off → the matching evidence is empty.
