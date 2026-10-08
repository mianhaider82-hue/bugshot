import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

/**
 * QA Reporter – Vite build for a Chrome Extension (Manifest V3).
 *
 * Design decisions:
 * 1. MV3 forbids remote code and requires CSP-safe bundles, so we disable
 *    Vite's dev-only HMR runtime in builds and inline nothing external.
 * 2. Chrome expects concrete file paths for the service worker and content
 *    scripts. We therefore build multiple named entry points instead of one
 *    SPA bundle:
 *      - popup  -> index.html (action popup, React app)
 *      - background -> src/background/index.ts (service worker)
 *      - content    -> src/content/index.ts   (content script, no React)
 * 3. Content scripts cannot be ES modules in MV3, so the content bundle is
 *    emitted as an IIFE with no code-splitting (chrome.runtime messaging is
 *    used to reach the service worker instead of imports at runtime).
 */
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'chrome120',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'index.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
      },
      output: {
        // Keep deterministic names so manifest.json can reference them.
        entryFileNames: (chunk) => {
          if (chunk.name === 'background') return 'background.js';
          if (chunk.name === 'content') return 'content.js';
          return 'assets/[name].js';
        },
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
