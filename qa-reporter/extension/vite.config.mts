import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { copyFileSync, readFileSync, writeFileSync } from 'fs';

/**
 * QA Reporter – Vite build for a Chrome Extension (Manifest V3).
 *
 * Documented Chrome API / build decisions:
 * 1. MV3 forbids remote code and enforces a strict CSP (`script-src 'self'`),
 *    so everything is bundled locally — no CDN imports, no eval, no dev-only
 *    HMR runtime in the production output.
 * 2. Chrome expects concrete, stable file paths for the service worker and
 *    content scripts. We therefore build three named entry points:
 *      - popup/popup.html -> React popup app (hashed assets allowed)
 *      - background.js    -> service worker
 *      - content.js       -> content script
 *    A small `closeBundle` plugin relocates the deterministic bundles to the
 *    exact manifest paths and copies the manifest into dist (validated).
 * 3. Content scripts cannot be ES modules in current stable Chrome, so all
 *    bundles are emitted as classic scripts (format: 'iife', no exports).
 *    The background/content sources only import *types* + pure helpers, which
 *    Rollup inlines — keeping each bundle self-contained.
 * 4. The manifest shipped in dist must reference BUILT files (background.js),
 *    never source .ts paths — the plugin below fails the build if it doesn't.
 */

const rootDir = dirname(fileURLToPath(import.meta.url));
let capturedOutDir: string | undefined;

/** Vite plugin: emit manifest + relocate deterministic bundles post-build. */
function chromeBundlePlugin() {
  return {
    name: 'qa-reporter-chrome-bundle',
    apply: 'build' as const,
    configResolved(cfg: { build: { outDir?: string } }) {
      capturedOutDir = resolve(rootDir, cfg.build.outDir ?? 'dist');
    },
    closeBundle() {
      const outDir = capturedOutDir ?? resolve(rootDir, 'dist');

      // Deterministic single-file outputs land next to their chunk names.
      const relocs: Array<[string, string]> = [
        ['src/background/index.js', 'background.js'],
        ['src/content/index.js', 'content.js'],
      ];
      for (const [from, to] of relocs) {
        try {
          copyFileSync(resolve(outDir, from), resolve(outDir, to));
        } catch {
          /* missing bundle → surfaced by manifest validation below */
        }
      }

      // Copy + validate manifest so it always references built files.
      const manifestRaw = readFileSync(resolve(rootDir, 'manifest.json'), 'utf8');
      const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
      const bg = (manifest.background as { service_worker?: string }) ?? {};
      const cs = (manifest.content_scripts as Array<{ js?: string[] }>) ?? [];
      if (!bg.service_worker?.endsWith('.js') || !cs[0]?.js?.[0]?.endsWith('.js')) {
        throw new Error('[chrome-bundle] manifest must reference built .js files');
      }
      writeFileSync(resolve(outDir, 'manifest.json'), manifestRaw);
    },
  };
}

export default defineConfig({
  root: rootDir,
  base: './',
  plugins: [react(), chromeBundlePlugin()],
  build: {
    target: 'chrome120',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: { polyfill: false }, // avoid preload links around extension pages
    rollupOptions: {
      input: {
        popup: resolve(rootDir, 'popup/popup.html'),
        background: resolve(rootDir, 'src/background/index.ts'),
        content: resolve(rootDir, 'src/content/index.ts'),
      },
      output: {
        format: 'iife',
        inlineDynamicImports: false,
        entryFileNames: (chunk) => {
          // background/content are relocated by the plugin after the build;
          // popup assets keep stable names referenced from popup.html.
          if (chunk.name === 'background') return 'src/background/index.js';
          if (chunk.name === 'content') return 'src/content/index.js';
          return 'popup/assets/[name].js';
        },
        chunkFileNames: 'popup/assets/[name].js',
        assetFileNames: 'popup/assets/[name].[ext]',
      },
    },
  },
});
