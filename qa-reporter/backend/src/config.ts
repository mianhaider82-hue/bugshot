/** Environment configuration. Secrets live only here, never in the extension. */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  /** Public URL of this server, used for the Google OAuth redirect. */
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4000}`).replace(/\/$/, ''),
  claudeModel: process.env.CLAUDE_MODEL ?? 'claude-opus-5-5',
  /** Where OAuth tokens and session tokens are stored (JSON files). */
  dataDir: process.env.DATA_DIR ?? './data',
  google: {
    get clientId() {
      return required('GOOGLE_CLIENT_ID');
    },
    get clientSecret() {
      return required('GOOGLE_CLIENT_SECRET');
    },
  },
  /** Optional comma-separated extension IDs allowed to call the API (CORS). Empty = any extension. */
  allowedExtensionIds: (process.env.ALLOWED_EXTENSION_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
