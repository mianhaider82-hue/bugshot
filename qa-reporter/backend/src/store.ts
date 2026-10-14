/**
 * Tiny JSON-file store for reporter session tokens and the Google OAuth
 * tokens of the account this backend writes to. One Google account per
 * backend: every tester's report lands in that account's spreadsheet.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Credentials } from 'google-auth-library';
import { config } from './config.js';

interface StoreData {
  sessions: Record<string, { createdAt: string; client: string }>;
  google?: Credentials & { email?: string };
}

const file = join(config.dataDir, 'store.json');
let data: StoreData = load();

function load(): StoreData {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as StoreData;
  } catch {
    return { sessions: {} };
  }
}

function save(): void {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function createSession(client: string): string {
  const token = randomBytes(24).toString('base64url');
  data.sessions[token] = { createdAt: new Date().toISOString(), client };
  save();
  return token;
}

export function isValidSession(token: string): boolean {
  return Object.hasOwn(data.sessions, token);
}

export function getGoogleTokens(): StoreData['google'] {
  return data.google;
}

export function setGoogleTokens(tokens: StoreData['google']): void {
  // Google only returns a refresh_token on first consent – keep the old one.
  data.google = { ...data.google, ...tokens, refresh_token: tokens?.refresh_token ?? data.google?.refresh_token };
  save();
}

export function clearGoogleTokens(): void {
  delete data.google;
  save();
}

/** Reload from disk (tests / manual edits). */
export function reloadStore(): void {
  data = load();
}
