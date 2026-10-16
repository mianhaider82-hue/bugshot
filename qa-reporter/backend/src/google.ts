/**
 * Google OAuth + Sheets + Drive.
 *
 * The backend is the OAuth client; tokens never reach the extension.
 * Screenshots are stored on Cloudinary (storage.ts), not in Drive.
 */

import { OAuth2Client } from 'google-auth-library';
import { sheets as sheetsApi } from '@googleapis/sheets';
import { drive as driveApi } from '@googleapis/drive';
import { config } from './config.js';
import { clearGoogleTokens, getGoogleTokens, setGoogleTokens } from './store.js';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.metadata.readonly', // list spreadsheets in Settings
  'https://www.googleapis.com/auth/userinfo.email',
];

export class NotConnectedError extends Error {
  constructor() {
    super('Google account not connected. Open the extension Settings and click "Connect Google".');
  }
}

function oauthClient(): OAuth2Client {
  return new OAuth2Client({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: `${config.publicUrl}/api/auth/google/callback`,
  });
}

export function authUrl(): string {
  return oauthClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
}

export async function handleCallback(code: string): Promise<string | undefined> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  let email: string | undefined;
  if (tokens.id_token) {
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.google.clientId });
    email = ticket.getPayload()?.email;
  }
  setGoogleTokens({ ...tokens, email });
  return email;
}

function authedClient(): OAuth2Client {
  const tokens = getGoogleTokens();
  if (!tokens?.refresh_token && !tokens?.access_token) throw new NotConnectedError();
  const client = oauthClient();
  client.setCredentials(tokens);
  client.on('tokens', (t) => setGoogleTokens({ ...getGoogleTokens(), ...t }));
  return client;
}

export function connectedEmail(): string | null {
  const t = getGoogleTokens();
  return t ? (t.email ?? 'connected') : null;
}

export function disconnect(): void {
  clearGoogleTokens();
}

/* ------------------------------------------------------------------ */
/* Drive                                                              */
/* ------------------------------------------------------------------ */

export async function listSpreadsheets(): Promise<Array<{ id: string; title: string }>> {
  const drive = driveApi({ version: 'v3', auth: authedClient() });
  const res = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    orderBy: 'modifiedTime desc',
    pageSize: 50,
    fields: 'files(id,name)',
  });
  return (res.data.files ?? []).map((f) => ({ id: f.id ?? '', title: f.name ?? '(untitled)' }));
}

/* ------------------------------------------------------------------ */
/* Sheets                                                             */
/* ------------------------------------------------------------------ */

export async function listWorksheets(spreadsheetId: string): Promise<Array<{ title: string }>> {
  const sheets = sheetsApi({ version: 'v4', auth: authedClient() });
  const res = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  return (res.data.sheets ?? []).map((s) => ({ title: s.properties?.title ?? '' }));
}

export const SHEET_HEADERS = [
  'ID',
  'Created',
  'Type',
  'Title',
  'Severity',
  'Priority',
  'Description',
  'Steps to reproduce',
  'Expected result',
  'Actual result',
  'Tester notes',
  'Possible cause (AI)',
  'Page URL',
  'Browser',
  'OS',
  'Viewport',
  'Console errors',
  'API errors',
  'Screenshot',
];

/** Append one report row; creates the worksheet and header row when missing. */
export async function appendRow(spreadsheetId: string, worksheet: string, row: string[]): Promise<string> {
  const sheets = sheetsApi({ version: 'v4', auth: authedClient() });
  const existing = await listWorksheets(spreadsheetId);
  if (!existing.some((w) => w.title === worksheet)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: worksheet } } }] },
    });
  }
  const range = `'${worksheet.replace(/'/g, "''")}'`;
  const head = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${range}!A1:A1` });
  if (!head.data.values?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${range}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADERS] },
    });
  }
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${range}!A1`,
    // RAW: tester text starting with '=' must never be evaluated as a formula.
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  return res.data.updates?.updatedRange ?? '';
}
