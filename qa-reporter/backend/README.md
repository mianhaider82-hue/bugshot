# QA Reporter backend

Small Express server used by the QA Reporter extension:

- `POST /api/analyze` sends the screenshot, the tester's note and the console/network evidence to OpenAI GPT-4o and returns a structured report (title, description, steps, expected/actual result, severity, priority, possible cause).
- `POST /api/screenshot` uploads the annotated screenshot to Cloudinary (folder `CLOUDINARY_FOLDER`, default `qa-reporter`) and returns its URL.
- Google OAuth + Sheets: appends one row per report, linking to the Cloudinary screenshot.

API keys and Google tokens stay on this server. The extension only holds an anonymous session token.

## Setup

```bash
cp .env.example .env     # fill in OPENAI_API_KEY, CLOUDINARY_*, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
npm install
npm run dev              # http://localhost:4000
```

Google Cloud console:
1. Create an OAuth client of type **Web application**, with redirect URI `http://localhost:4000/api/auth/google/callback`.
2. Enable the **Google Sheets API** and the **Google Drive API** (Drive is only used to list your spreadsheets).
3. While the app is in testing mode, add your account as a test user.

Then in the extension: **Settings → Connect Google**, pick a spreadsheet, and save.

One Google account per backend. Every report goes to that account's spreadsheet. Screenshots live in your Cloudinary account; their URLs are public but unguessable, so anyone with the sheet link can open them.

## Production

`npm run build && npm start`. Set `PUBLIC_URL` to the HTTPS URL, register the matching redirect URI, and set `ALLOWED_EXTENSION_IDS` so only your extension can call the API.
