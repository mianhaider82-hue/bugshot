# Add "Create GitHub issue" (per-tester GitHub accounts)

## Context
Testers want to raise a report straight to a GitHub repo, in addition to Google Sheets. Unlike Google, which uses one account per backend, **each tester connects their own GitHub account**. They pick a repo from their own list, and the issue is opened under their name. On the review screen, a separate **Create GitHub issue** button sits next to "Add to Google Sheets". The screenshot is already uploaded to Cloudinary with a public URL, so it can be embedded in the issue body as an image.

## Approach
I'll use a GitHub **OAuth App** with scope `repo`, which lets testers file issues on private repos too. The OAuth flow mirrors the existing Google one: a backend redirect in a normal tab, with no `chrome.identity`. Tokens never reach the extension; the backend stores them **per reporter session**. I'll call GitHub with plain `fetch` (three endpoints), so no new dependency is needed.

### Backend (`qa-reporter/backend`)
1. **`config.ts`**: add a `github` block with lazy `required()` getters, following the Google pattern, for `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
2. **`store.ts`**:
   - Extend the session record with `github?: { accessToken: string; login: string }`.
   - Add `getGithub(token)`, `setGithub(token, v)` and `clearGithub(token)`.
   - Add an in-memory `pendingStates: Map<state, { session, expires }>` (10 min TTL, single use) for the OAuth `state`. The session token is never put in a URL.
3. **New `github.ts`**:
   - `startAuth(session)`: create a random `state` and return `https://github.com/login/oauth/authorize?client_id&redirect_uri=${publicUrl}/api/auth/github/callback&scope=repo&state`.
   - `handleCallback(code, state)`:
     1. Resolve `state` to a session and reject it if it is unknown or expired.
     2. POST `https://github.com/login/oauth/access_token` with `Accept: application/json`.
     3. GET `/user` to read `login`, then call `setGithub`.
   - `listRepos(session)`: GET `/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100`, keep repos with `has_issues && !archived`, and map them to `{ fullName, private }`.
   - `createIssue(session, repo, report, screenshotUrl)`:
     - POST `/repos/{owner}/{repo}/issues` with `{ title, body, labels }`.
     - Use `bug` for bug reports and `enhancement` for design/improvement. GitHub silently drops labels the user can't set.
     - Return `{ number, url: html_url }`.
   - `GitHubNotConnectedError`, plus a helper that turns GitHub error responses into `{ status, message }`.
   - Shared headers: `Authorization: Bearer`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`.
4. **`report.ts`**:
   - Split the existing `report` object into an exported `ReportSchema`. `SubmitRequestSchema` reuses it.
   - Add `IssueRequestSchema = { repo: /^[\w.-]+\/[\w.-]+$/, report: ReportSchema, screenshotUrl? }`.
   - Add `reportToIssueBody(report, screenshotUrl)`, which builds Markdown from the same fields as `reportToRow`:
     - Description, numbered steps, expected and actual result.
     - `![Screenshot](url)`.
     - Severity, priority, page URL and an environment table.
     - Possible cause.
     - Console errors and failed API calls inside `<details>` code blocks.
     - A footer: report ID, "Filed with QA Reporter".
   - Body is capped at GitHub's 65,536 characters.
5. **`index.ts`** routes, all behind `requireSession` except the callback:
   - `POST /api/auth/github/start` → `{ url }`
   - `GET /api/auth/github/callback` → success page, using the existing `page()` helper
   - `GET /api/github/me` → `{ login | null }`
   - `POST /api/github/logout`
   - `GET /api/github/repos` → `{ repos }`
   - `POST /api/github/issues` → `{ number, url }`
   - Error handler: `GitHubNotConnectedError` returns 401. GitHub API errors return 502 with GitHub's message, except 401/403/404, which become 403 with a hint ("no access to this repo / token revoked; reconnect GitHub").
   - Update the route list in the header comment.
6. **`.env.example` and `README.md`**:
   - Add `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
   - Add setup steps: GitHub → Settings → Developer settings → OAuth Apps → New, with callback URL `<PUBLIC_URL>/api/auth/github/callback`.
   - Note that orgs with third-party access restrictions must approve the app before their repos appear.

### Extension (`qa-reporter/extension/src`)
1. **`types/index.ts`**:
   - Add `githubRepo: string` to `AppSettings` (default `''`).
   - Add `githubIssueUrl?: string` and `screenshotUrl?: string` to `BugReport`. Caching the Cloudinary URL means using both Sheets and GitHub uploads the screenshot only once.
2. **New `services/github.ts`**, reusing the `authedFetch` pattern from `services/google.ts`:
   - `startGithubAuth(backendUrl)` gets the authorize URL and opens it with `window.open`.
   - Also `githubMe`, `githubLogout` and `listGithubRepos`.
3. **`services/api.ts`**: add `BackendClient.createGithubIssue(report, repo, screenshotUrl)`. It reuses `toSheetPayload` for the report shape and calls `POST /api/github/issues`.
4. **`components/SettingsScreen.tsx`**: add a new **GitHub** card.
   - It shows "Connected as @login" or "Not connected", with **Connect GitHub**, **Check connection** and **Disconnect** buttons.
   - It has a repo `<select>` populated from `listGithubRepos`, labelled "private" where relevant. The selection is saved to `draft.githubRepo`.
   - It follows the existing Google Sheets card's structure.
5. **`editor/useEditorSession.ts`**:
   - Extract the screenshot upload in `submitToSheets` into an `ensureScreenshotUrl(client, report)` helper. It reuses `report.screenshotUrl` when present and stores it otherwise.
   - Add `submitToGitHub()`, which works like `submitToSheets`:
     1. If there is no repo, show the error "Choose a GitHub repo in Settings first".
     2. Set the phase to `submitting`.
     3. Upload the screenshot.
     4. Call `createGithubIssue`.
     5. On success, call `finish({ ...r, githubIssueUrl, status: 'submitted' })` and show a notice: "`ID` filed as owner/repo#N".
     6. On failure, stay on review with "GitHub failed: …".
6. **`ReviewScreen.tsx` and `EditorApp.tsx`**:
   - Add `'github'` to `ExportAction` and a **Create GitHub issue** button next to "Add to Google Sheets".
   - Route `'github'` to `s.submitToGitHub()`.
   - When `githubIssueUrl` is set, the done screen and notice show a link that opens the issue.
7. **`services/export.ts` `toMarkdown`**: no change.

## Verification
1. `npm run typecheck` in `backend`, then `npm run build` in `extension`.
2. Register a GitHub OAuth App with callback `http://localhost:4000/api/auth/github/callback` and put its ID and secret in `.env`. Then run `npm run dev`.
3. In the extension: Settings → Connect GitHub → authorize in the tab. Check connection should show "@your-login", and the repo dropdown should list your repos. Pick a test repo and save.
4. Capture → annotate → review → **Create GitHub issue**. The issue should appear on GitHub under your account with the screenshot rendered, steps, environment and the right label. The notice should link to it.
5. Then **Add to Google Sheets** on the same report. It should reuse `screenshotUrl` (one Cloudinary upload in the logs).
6. Error paths:
   - No repo selected gives a clear error.
   - Revoking the app on GitHub, then submitting, gives a "reconnect GitHub" message.
   - Reusing an expired or forged `state` on the callback is rejected.
   - A second extension install with its own session doesn't see the first tester's GitHub connection.
