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
  openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4o',
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
  cloudinary: {
    get cloudName() {
      return required('CLOUDINARY_CLOUD_NAME');
    },
    get apiKey() {
      return required('CLOUDINARY_API_KEY');
    },
    get apiSecret() {
      return required('CLOUDINARY_API_SECRET');
    },
    folder: process.env.CLOUDINARY_FOLDER ?? 'qa-reporter',
  },
  /** Optional comma-separated extension IDs allowed to call the API (CORS). Empty = any extension. */
  allowedExtensionIds: (process.env.ALLOWED_EXTENSION_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
