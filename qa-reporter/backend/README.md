# QA Reporter backend

Small Express server used by the QA Reporter extension:

- `POST /api/analyze` sends the screenshot, the tester's note and the console/network evidence to Claude and returns a structured report (title, description, steps, expected/actual result, severity, priority, possible cause).
- Google OAuth + Sheets: appends one row per report and uploads the screenshot to Drive (folder *QA Reporter Screenshots*).

API keys and Google tokens stay on this server. The extension only holds an anonymous session token.

## Setup

```bash
cp .env.example .env     # fill in ANTHROPIC_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
npm install
npm run dev              # http://localhost:4000
```

Google Cloud console:
1. Create an OAuth client of type **Web application**, with redirect URI `http://localhost:4000/api/auth/google/callback`.
2. Enable the **Google Sheets API** and the **Google Drive API**.
3. While the app is in testing mode, add your account as a test user.

Then in the extension: **Settings → Connect Google**, pick a spreadsheet, and save.

One Google account per backend. Every report goes to that account's spreadsheet, and screenshots are stored privately in its Drive. Anyone who opens the screenshot link needs access to that Drive file.

## Production

`npm run build && npm start`. Set `PUBLIC_URL` to the HTTPS URL, register the matching redirect URI, and set `ALLOWED_EXTENSION_IDS` so only your extension can call the API.
